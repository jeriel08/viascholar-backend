import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { Role } from '../../generated/prisma/enums.js';
import {
  calculateScholarGwa,
  evaluateScholarHealth,
} from '../utils/scholar-evaluation.util.js';

@Injectable()
export class GrantorDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: AppCacheService,
  ) {}

  /**
   * Fast aggregated summary endpoint for Grantor Dashboard (Executive Operations).
   * Cached for 60 seconds per grantor unless forceRefresh is true.
   */
  async getGrantorDashboardSummary(
    grantorUserId: number,
    forceRefresh = false,
  ) {
    const cacheKey = `dashboard:grantor:${grantorUserId}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const today = new Date(new Date().setHours(0, 0, 0, 0));

        const [
          endorsedApps,
          allActiveApps,
          pendingAppealsList,
          pendingDisbursementsList,
          recentDisbursementsList,
          scholarProfiles,
          meetings,
          conversations,
          systemSetting,
        ] = await Promise.all([
          // 1. Endorsed Applicants awaiting Grantor Verdict
          this.prisma.application.findMany({
            where: {
              stage: 'ENDORSED_TO_GRANTOR',
              scholar_profile: {
                user: {
                  role: Role.APPLICANT,
                  is_active: true,
                },
              },
            },
            orderBy: { stage_updated_at: 'desc' },
            take: 6,
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

          // 2. Count of all prospective applicants in pipeline
          this.prisma.application.count({
            where: {
              stage: { not: 'Draft' },
              scholar_profile: {
                user: {
                  role: Role.APPLICANT,
                  is_active: true,
                },
              },
            },
          }),

          // 3. Grade Retention Appeals awaiting Grantor Verdict
          this.prisma.gradeReport.findMany({
            where: {
              appeal_status: 'PENDING_GRANTOR',
            },
            orderBy: { appeal_submitted_at: 'desc' },
            take: 6,
            include: {
              scholar_profile: {
                select: {
                  profile_id: true,
                  first_name: true,
                  last_name: true,
                  course_of_study: true,
                  school_name: true,
                  school_grading_system: true,
                  user: {
                    select: {
                      email: true,
                    },
                  },
                },
              },
            },
          }),

          // 4. Disbursements awaiting Authorization or Release
          this.prisma.disbursement.findMany({
            where: {
              status: { in: ['PENDING', 'AUTHORIZED'] },
            },
            orderBy: { created_at: 'desc' },
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

          // 5. Recent Disbursements overview (all statuses)
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

          // 6. Active Scholars Health
          this.prisma.scholarProfile.findMany({
            where: {
              user: {
                role: Role.SCHOLAR,
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

          // 7. Executive Meetings
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

          // 8. Conversations
          this.prisma.conversation.findMany({
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

          // 9. System Settings
          this.prisma.systemSetting.findFirst(),
        ]);

        const gradeThreshold = systemSetting?.grade_threshold
          ? Number(systemSetting.grade_threshold)
          : 90.0;

        // Scholar Health Standings
        let goodStandingCount = 0;
        let probationCount = 0;
        let actionRequiredCount = 0;

        const scholarsSummary = scholarProfiles.map((scholar) => {
          const name =
            `${scholar.first_name} ${scholar.last_name}`.trim() ||
            scholar.user.email.split('@')[0];
          const school =
            scholar.school_name ||
            scholar.school_grading_system?.school_name ||
            'Unassigned';
          const course = scholar.course_of_study || 'General';

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
            userId: scholar.user.user_id,
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

        // Financial sums
        const pendingDisbursementsSum = pendingDisbursementsList.reduce(
          (acc, d) => acc + Number(d.amount),
          0,
        );

        const totalDisbursedSum = recentDisbursementsList
          .filter(
            (d) =>
              d.status === 'RELEASED' ||
              d.status === 'CLAIMED' ||
              d.status === 'SETTLED',
          )
          .reduce((acc, d) => acc + Number(d.amount), 0);

        const pendingOrCount = recentDisbursementsList.filter(
          (d) =>
            (d.status === 'RELEASED' || d.status === 'CLAIMED') &&
            !d.or_document_id,
        ).length;

        return {
          kpis: {
            endorsedApplicantsCount: endorsedApps.length,
            totalApplicants: allActiveApps,
            pendingAppealsCount: pendingAppealsList.length,
            pendingDisbursementsCount: pendingDisbursementsList.length,
            pendingDisbursementsSum,
            totalScholars: scholarProfiles.length,
            goodStandingCount,
            probationCount,
            actionRequiredCount,
            totalDisbursedSum,
            pendingOrCount,
          },
          endorsedApplicants: endorsedApps.map((app) => ({
            id: app.application_id,
            name:
              `${app.scholar_profile.first_name} ${app.scholar_profile.last_name}`.trim() ||
              app.scholar_profile.user.email,
            email: app.scholar_profile.user.email,
            track: app.scholar_profile.scholarship_track || 'General',
            school: app.scholar_profile.school_name || 'N/A',
            stage: app.stage,
            status: app.status,
            submitted_at: app.submitted_at?.toISOString(),
            stage_updated_at: app.stage_updated_at?.toISOString() || null,
          })),
          pendingAppeals: pendingAppealsList.map((appeal) => ({
            id: appeal.report_id,
            scholar_name:
              `${appeal.scholar_profile.first_name} ${appeal.scholar_profile.last_name}`.trim() ||
              appeal.scholar_profile.user.email,
            school: appeal.scholar_profile.school_name || 'N/A',
            course: appeal.scholar_profile.course_of_study || 'N/A',
            term: `${appeal.academic_year} • ${appeal.semester}`,
            gpa: Number(appeal.gpa),
            appeal_status: appeal.appeal_status,
            appeal_notes: appeal.appeal_notes || 'No statement provided',
            submitted_at:
              appeal.appeal_submitted_at?.toISOString() ||
              appeal.submitted_at?.toISOString(),
          })),
          pendingDisbursements: pendingDisbursementsList.map((d) => ({
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
          scholars: scholarsSummary.slice(0, 5),
          meetings: meetings.map((m) => {
            const attendee = m.scholar_profile
              ? `${m.scholar_profile.first_name} ${m.scholar_profile.last_name}`.trim()
              : m.application?.scholar_profile
                ? `${m.application.scholar_profile.first_name} ${m.application.scholar_profile.last_name}`.trim()
                : 'Coordinator';
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
