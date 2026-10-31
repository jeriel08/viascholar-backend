import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { Role } from '../../generated/prisma/enums.js';
import {
  calculateScholarGwa,
  evaluateScholarHealth,
} from '../utils/scholar-evaluation.util.js';

@Injectable()
export class CoordinatorDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: AppCacheService,
  ) {}

  /**
   * Fast aggregated summary endpoint for Coordinator Dashboard.
   * Cached for 60 seconds per coordinator unless forceRefresh is true.
   */
  async getCoordinatorDashboardSummary(
    coordinatorUserId: number,
    forceRefresh = false,
  ) {
    const cacheKey = `dashboard:coordinator:${coordinatorUserId}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const today = new Date(new Date().setHours(0, 0, 0, 0));

        const [
          applications,
          scholarProfiles,
          pendingEnrollments,
          disbursements,
          meetings,
          conversations,
          systemSetting,
        ] = await Promise.all([
          // 1. Applications with scholar profile details (Genuine prospective applicants)
          this.prisma.application.findMany({
            where: {
              stage: { not: 'Draft' },
              scholar_profile: {
                user: {
                  role: Role.APPLICANT,
                  is_active: true,
                },
              },
            },
            orderBy: { submitted_at: 'desc' },
            include: {
              scholar_profile: {
                select: {
                  profile_id: true,
                  first_name: true,
                  last_name: true,
                  scholarship_track: true,
                  course_of_study: true,
                  school_name: true,
                  avatar_url: true,
                  user: {
                    select: {
                      email: true,
                    },
                  },
                },
              },
            },
          }),

          // 2. Active Scholars with grade reports & prospectus
          this.prisma.scholarProfile.findMany({
            where: {
              user: {
                role: 'SCHOLAR',
                is_active: true,
              },
            },
            include: {
              user: {
                select: {
                  user_id: true,
                  email: true,
                },
              },
              school_grading_system: true,
              grade_reports: {
                orderBy: { submitted_at: 'desc' },
                take: 1,
              },
              prospectus: {
                include: {
                  subjects: {
                    where: { status: { in: ['PASSED', 'CREDITED'] } },
                    select: { units: true, grade: true },
                  },
                },
              },
            },
            orderBy: { profile_id: 'desc' },
          }),

          // 3. Term Enrollments Queue
          this.prisma.termEnrollment.findMany({
            orderBy: { created_at: 'desc' },
            take: 6,
            include: {
              scholar_profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  school_name: true,
                  course_of_study: true,
                  user: { select: { email: true } },
                },
              },
            },
          }),

          // 4. Disbursements
          this.prisma.disbursement.findMany({
            orderBy: { disbursement_id: 'desc' },
            take: 6,
            include: {
              scholar_profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  user: { select: { email: true } },
                },
              },
            },
          }),

          // 5. Coordinator Meetings
          this.prisma.meeting.findMany({
            where: {
              meeting_date: { gte: today },
            },
            orderBy: { meeting_date: 'asc' },
            take: 5,
            include: {
              scholar_profile: {
                select: {
                  first_name: true,
                  last_name: true,
                },
              },
              application: {
                include: {
                  scholar_profile: {
                    select: {
                      first_name: true,
                      last_name: true,
                    },
                  },
                },
              },
            },
          }),

          // 6. Direct Conversations with scholars
          this.prisma.conversation.findMany({
            where: {
              coordinator_user_id: coordinatorUserId,
            },
            orderBy: { updated_at: 'desc' },
            take: 5,
            include: {
              scholar: {
                select: {
                  user_id: true,
                  email: true,
                  scholar_profile: {
                    select: {
                      first_name: true,
                      last_name: true,
                      avatar_url: true,
                    },
                  },
                },
              },
              messages: {
                orderBy: { sent_at: 'desc' },
                take: 1,
              },
            },
          }),

          // 7. System Setting for grade threshold
          this.prisma.systemSetting.findFirst(),
        ]);

        const gradeThreshold = systemSetting?.grade_threshold
          ? Number(systemSetting.grade_threshold)
          : 90.0;

        // A. Applicant Pipeline metrics
        const totalApplicants = applications.length;
        const stageCounts: Record<string, number> = {
          PRE_SCREENING: 0,
          DOCUMENT_VERIFICATION: 0,
          FOR_INTERVIEW: 0,
          INTERVIEW_SCHEDULED: 0,
          ENDORSED_TO_GRANTOR: 0,
          APPROVED: 0,
          REJECTED: 0,
        };

        for (const app of applications) {
          const stage = app.stage?.toUpperCase() || 'PRE_SCREENING';
          if (stageCounts[stage] !== undefined) {
            stageCounts[stage]++;
          } else {
            stageCounts.PRE_SCREENING++;
          }
        }

        const pendingReviewApplicants =
          stageCounts.PRE_SCREENING +
          stageCounts.DOCUMENT_VERIFICATION +
          stageCounts.FOR_INTERVIEW;

        // B. Scholar Health & Baseline Freeze Queue
        let goodStandingCount = 0;
        let probationCount = 0;
        let actionRequiredCount = 0;
        let pendingBaselineFreezeCount = 0;

        const scholarsSummary = scholarProfiles.map((scholar) => {
          const name =
            `${scholar.first_name} ${scholar.last_name}`.trim() ||
            scholar.user.email.split('@')[0];
          const school =
            scholar.school_name ||
            scholar.school_grading_system?.school_name ||
            'Unassigned';
          const course = scholar.course_of_study || 'General';

          // Check baseline freeze status
          const isBaselinePending =
            scholar.academic_baseline_status === 'PENDING_COORDINATOR_REVIEW' ||
            !scholar.prospectus?.is_frozen;
          if (isBaselinePending) {
            pendingBaselineFreezeCount++;
          }

          // Calculate GWA
          const gwa = calculateScholarGwa(scholar, gradeThreshold);
          const latestReport = scholar.grade_reports[0];

          // Health Standing with accurate school grading scale
          const health = evaluateScholarHealth(
            gwa,
            scholar,
            latestReport,
            gradeThreshold,
          );
          if (health === 'bad') {
            actionRequiredCount++;
          } else if (health === 'warn') {
            probationCount++;
          } else {
            goodStandingCount++;
          }

          return {
            id: scholar.profile_id,
            user_id: scholar.user.user_id,
            name,
            email: scholar.user.email,
            school,
            course,
            gwa: Number(gwa.toFixed(2)),
            health,
            academic_baseline_status: scholar.academic_baseline_status,
            is_frozen: scholar.prospectus?.is_frozen || false,
          };
        });

        // C. Term Enrollments Queue Breakdown (only count genuine submissions with documents)
        const pendingEnrollmentsCount = pendingEnrollments.filter(
          (e) =>
            e.status === 'PENDING_REVIEW' &&
            (e.cor_document_id != null || e.soa_document_id != null),
        ).length;

        // D. Disbursements & OR Clearance Breakdown
        const pendingOrCount = disbursements.filter(
          (d) =>
            (d.status === 'RELEASED' || d.status === 'CLAIMED') &&
            !d.or_document_id,
        ).length;
        const totalDisbursedSum = disbursements
          .filter(
            (d) =>
              d.status === 'RELEASED' ||
              d.status === 'CLAIMED' ||
              d.status === 'SETTLED',
          )
          .reduce((acc, d) => acc + Number(d.amount), 0);

        // E. Total Unread Messages for Coordinator
        const unreadMessagesCount = await this.prisma.message.count({
          where: {
            conversation: {
              coordinator_user_id: coordinatorUserId,
            },
            sender_user_id: { not: coordinatorUserId },
            is_read: false,
          },
        });

        return {
          kpis: {
            totalScholars: scholarProfiles.length,
            goodStandingCount,
            probationCount,
            actionRequiredCount,
            pendingBaselineFreezeCount,
            totalApplicants,
            pendingReviewApplicants,
            endorsedApplicantsCount: stageCounts.ENDORSED_TO_GRANTOR,
            pendingEnrollmentsCount,
            pendingOrCount,
            totalDisbursedSum,
            unreadMessagesCount,
          },
          applicantStages: stageCounts,
          recentApplicants: applications.slice(0, 5).map((app) => ({
            id: app.application_id,
            name:
              `${app.scholar_profile.first_name} ${app.scholar_profile.last_name}`.trim() ||
              app.scholar_profile.user.email,
            track: app.scholar_profile.scholarship_track || 'General',
            school: app.scholar_profile.school_name || 'N/A',
            stage: app.stage,
            status: app.status,
            submitted_at: app.submitted_at?.toISOString(),
          })),
          scholars: scholarsSummary.slice(0, 5),
          enrollmentQueue: pendingEnrollments.map((e) => {
            const hasCor = Boolean(e.cor_document_id);
            const hasSoa = Boolean(e.soa_document_id);
            let displayStatus = e.status;
            if (!hasCor && !hasSoa && e.status === 'PENDING_REVIEW') {
              displayStatus = 'NO_COR_SUBMITTED';
            }
            return {
              enrollment_id: e.enrollment_id,
              scholar_name:
                `${e.scholar_profile.first_name} ${e.scholar_profile.last_name}`.trim() ||
                e.scholar_profile.user.email,
              term: `${e.academic_year} • ${e.semester}`,
              units: Number(e.total_units),
              assessment: Number(e.total_assessment),
              status: displayStatus,
              has_cor: hasCor,
              has_soa: hasSoa,
              created_at: e.created_at?.toISOString(),
            };
          }),
          disbursements: disbursements.map((d) => ({
            disbursement_id: d.disbursement_id,
            scholar_name:
              `${d.scholar_profile.first_name} ${d.scholar_profile.last_name}`.trim() ||
              d.scholar_profile.user.email,
            term: `${d.academic_year} • ${d.semester}`,
            amount: Number(d.amount),
            status: d.status,
            has_or: Boolean(d.or_document_id),
            date_issued: d.date_issued?.toISOString() || null,
            date_claimed: d.date_claimed?.toISOString() || null,
          })),
          meetings: meetings.map((m) => {
            const attendee = m.scholar_profile
              ? `${m.scholar_profile.first_name} ${m.scholar_profile.last_name}`.trim()
              : m.application?.scholar_profile
                ? `${m.application.scholar_profile.first_name} ${m.application.scholar_profile.last_name}`.trim()
                : 'Applicant';
            return {
              id: m.meeting_id,
              title: m.title,
              attendee,
              date: m.meeting_date?.toISOString(),
              time: m.meeting_time || 'Scheduled Time',
              meeting_link: m.meeting_link,
              status: m.status || 'SCHEDULED',
            };
          }),
          recentConversations: conversations.map((c) => ({
            id: c.conversation_id,
            scholar_id: c.scholar.user_id,
            scholar_name:
              `${c.scholar.scholar_profile?.first_name || ''} ${c.scholar.scholar_profile?.last_name || ''}`.trim() ||
              c.scholar.email,
            email: c.scholar.email,
            last_message:
              c.messages[0]?.message_text ||
              c.last_message_preview ||
              'No messages yet',
            last_message_at:
              c.messages[0]?.sent_at?.toISOString() ||
              c.updated_at?.toISOString(),
          })),
        };
      },
      60 * 1000,
      forceRefresh,
    );
  }
}
