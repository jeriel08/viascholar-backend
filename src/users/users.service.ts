import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { Role } from '../generated/prisma/enums.js';
import { QueryUsersDto } from './dto/query-users.dto.js';
import { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import { AdminResetPasswordDto } from './dto/reset-password.dto.js';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private eventsGateway: EventsGateway,
  ) {}

  // Get all users (Filtered by Role or Name search)
  async findAll(query: QueryUsersDto) {
    const where: any = {};

    if (query.role) {
      where.role = query.role;
    } else if (query.roles) {
      const roleList = query.roles
        .split(',')
        .map((r) => r.trim() as any)
        .filter(Boolean);
      if (roleList.length > 0) {
        where.role = { in: roleList };
      }
    }

    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        {
          scholar_profile: {
            first_name: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          scholar_profile: {
            last_name: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          scholar_profile: {
            course_of_study: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          scholar_profile: {
            scholarship_track: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          employee: {
            first_name: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          employee: {
            last_name: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: {
        user_id: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        scholar_profile: {
          include: {
            grade_reports: {
              orderBy: { submitted_at: 'desc' },
              take: 1,
              select: {
                report_id: true,
                gpa: true,
                status: true,
              },
            },
          },
        },
        employee: true,
      },
    });

    return users;
  }

  // Find single user profile
  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: id },
      select: {
        user_id: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        scholar_profile: {
          include: {
            grade_reports: {
              orderBy: { submitted_at: 'desc' },
              take: 1,
              select: {
                report_id: true,
                gpa: true,
                status: true,
              },
            },
          },
        },
        employee: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found.`);
    }

    return user;
  }

  // Toggle user active status (Enable / Disable account)
  async updateStatus(
    adminUserId: number,
    targetUserId: number,
    dto: UpdateUserStatusDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: targetUserId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found.`);
    }

    const updatedUser = await this.prisma.user.update({
      where: { user_id: targetUserId },
      data: { is_active: dto.is_active },
      select: {
        user_id: true,
        email: true,
        role: true,
        is_active: true,
      },
    });

    const actionLabel = dto.is_active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED';
    await this.auditService.log(
      adminUserId,
      actionLabel,
      `Admin (ID: ${adminUserId}) updated User status (ID: ${targetUserId}) to ${dto.is_active ? 'ACTIVE' : 'INACTIVE'}`,
    );

    this.eventsGateway.emitToAdmin('user:status_updated', {
      userId: targetUserId,
      isActive: dto.is_active,
      user: updatedUser,
    });
    this.eventsGateway.emitToUser(targetUserId, 'user:status_updated', {
      userId: targetUserId,
      isActive: dto.is_active,
    });

    return updatedUser;
  }

  async resetPassword(
    adminUserId: number,
    targetUserId: number,
    dto: AdminResetPasswordDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: targetUserId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found.`);
    }

    const hashedPassword = await bcrypt.hash(dto.new_password, 10);

    await this.prisma.user.update({
      where: { user_id: targetUserId },
      data: { password_hash: hashedPassword },
    });

    // 🚀 Audit log the password reset
    await this.auditService.log(
      adminUserId,
      'USER_PASSWORD_RESET',
      `Admin (ID: ${adminUserId}) reset password for User (ID: ${targetUserId})`,
    );

    this.eventsGateway.emitToAdmin('user:password_reset', {
      userId: targetUserId,
    });
    this.eventsGateway.emitToUser(targetUserId, 'user:password_reset', {
      userId: targetUserId,
    });

    return {
      message: `Password for user ID ${targetUserId} reset successfully.`,
    };
  }

  // Fast aggregated summary endpoint for Admin Dashboard
  async getAdminDashboardSummary() {
    const [
      staffUsers,
      totalStudents,
      activeScholars,
      applicants,
      schools,
      totalSchools,
      verifiedSchools,
      settings,
      recentLogs,
    ] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          employee: { isNot: null },
        },
        include: {
          employee: true,
        },
        orderBy: { user_id: 'desc' },
      }),
      this.prisma.user.count({
        where: {
          role: { in: ['SCHOLAR', 'APPLICANT'] },
        },
      }),
      this.prisma.user.count({
        where: {
          role: 'SCHOLAR',
          is_active: true,
        },
      }),
      this.prisma.user.count({
        where: {
          role: 'APPLICANT',
        },
      }),
      this.prisma.schoolGradingSystem.findMany({
        orderBy: { school_name: 'asc' },
        take: 5,
      }),
      this.prisma.schoolGradingSystem.count(),
      this.prisma.schoolGradingSystem.count({
        where: { is_verified: true },
      }),
      this.prisma.systemSetting.findFirst(),
      this.prisma.auditLog.findMany({
        take: 6,
        orderBy: { created_at: 'desc' },
        include: {
          user: {
            select: {
              user_id: true,
              email: true,
              role: true,
              scholar_profile: {
                select: { first_name: true, last_name: true },
              },
              employee: {
                select: { first_name: true, last_name: true },
              },
            },
          },
        },
      }),
    ]);

    const coordinatorCount = staffUsers.filter(
      (u) => u.role === 'COORDINATOR',
    ).length;
    const grantorCount = staffUsers.filter((u) => u.role === 'GRANTOR').length;
    const adminCount = staffUsers.filter((u) => u.role === 'ADMIN').length;
    const activeStaff = staffUsers.filter((u) => u.is_active).length;

    return {
      metrics: {
        totalStaff: staffUsers.length,
        activeStaff,
        coordinatorCount,
        grantorCount,
        adminCount,
        totalStudents,
        activeScholarsCount: activeScholars,
        applicantCount: applicants,
        totalSchools,
        verifiedSchools,
        gradeThreshold: settings?.grade_threshold
          ? Number(settings.grade_threshold)
          : 85,
      },
      staff: staffUsers.map((u) => ({
        id: u.user_id,
        name:
          `${u.employee?.first_name || ''} ${u.employee?.last_name || ''}`.trim() ||
          u.email,
        initials:
          `${(u.employee?.first_name || '')[0] || ''}${(u.employee?.last_name || '')[0] || ''}`.toUpperCase() ||
          'U',
        email: u.email,
        type:
          u.role === 'COORDINATOR'
            ? 'Coordinator'
            : u.role === 'GRANTOR'
              ? 'Grantor'
              : 'Admin',
        title: u.employee?.title || '',
        department: u.employee?.department || '',
        phone: '',
        active: u.is_active,
        joined: u.created_at
          ? new Date(u.created_at).toISOString().split('T')[0]
          : '',
      })),
      schools: schools.map((s) => ({
        school_id: s.school_id,
        school_name: s.school_name,
        grading_scale: s.grading_scale,
        passing_grade: Number(s.passing_grade),
        highest_grade: Number(s.highest_grade),
        failing_grade: Number(s.failing_grade),
        is_verified: s.is_verified,
        special_codes: (s.special_codes as Record<string, string>) || null,
        notes: s.notes,
        created_at: s.created_at?.toISOString() || '',
        updated_at: s.updated_at?.toISOString() || '',
      })),
      settings: settings
        ? {
            id: settings.setting_id,
            grade_retention_threshold: Number(settings.grade_threshold),
            updated_at: settings.updated_at?.toISOString() || '',
            updated_by_user_id: settings.updated_by_user_id,
          }
        : null,
      recentLogs: recentLogs.map((l) => ({
        log_id: l.log_id,
        user_id: l.user_id,
        action: l.action,
        details: l.details || '',
        created_at: l.created_at?.toISOString() || '',
        user: {
          user_id: l.user?.user_id || 0,
          email: l.user?.email || '',
          role: l.user?.role || 'SYSTEM',
          first_name:
            l.user?.employee?.first_name ||
            l.user?.scholar_profile?.first_name ||
            '',
          last_name:
            l.user?.employee?.last_name ||
            l.user?.scholar_profile?.last_name ||
            '',
        },
      })),
    };
  }

  // Fast aggregated summary endpoint for Coordinator Dashboard
  async getCoordinatorDashboardSummary(coordinatorUserId: number) {
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
      let gwa = 0;
      const latestReport = scholar.grade_reports[0];
      if (latestReport) {
        gwa = Number(latestReport.gpa);
      } else if (scholar.prospectus?.subjects?.length) {
        const graded = scholar.prospectus.subjects.filter(
          (s) => s.grade != null && !isNaN(Number(s.grade)),
        );
        if (graded.length > 0) {
          const totalW = graded.reduce(
            (acc, s) => acc + Number(s.grade) * (Number(s.units) || 3),
            0,
          );
          const totalU = graded.reduce(
            (acc, s) => acc + (Number(s.units) || 3),
            0,
          );
          gwa =
            totalU > 0
              ? Number((totalW / totalU).toFixed(2))
              : Number(graded[0].grade);
        } else {
          gwa = scholar.school_grading_system?.highest_grade
            ? Number(scholar.school_grading_system.highest_grade)
            : scholar.school_grading_system?.grading_scale === 'NUMERIC_5_POINT'
              ? 1.0
              : scholar.school_grading_system?.grading_scale ===
                  'NUMERIC_4_POINT'
                ? 4.0
                : gradeThreshold;
        }
      } else {
        gwa = scholar.school_grading_system?.highest_grade
          ? Number(scholar.school_grading_system.highest_grade)
          : scholar.school_grading_system?.grading_scale === 'NUMERIC_5_POINT'
            ? 1.0
            : scholar.school_grading_system?.grading_scale === 'NUMERIC_4_POINT'
              ? 4.0
              : gradeThreshold;
      }

      // Health Standing with accurate school grading scale
      const health = this.evaluateScholarHealth(
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
          c.messages[0]?.sent_at?.toISOString() || c.updated_at?.toISOString(),
      })),
    };
  }

  // Fast aggregated summary endpoint for Grantor Dashboard (Executive Operations)
  async getGrantorDashboardSummary(grantorUserId: number) {
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

      let gwa = 0;
      const latestReport = scholar.grade_reports[0];
      if (latestReport) {
        gwa = Number(latestReport.gpa);
      } else if (scholar.prospectus?.subjects?.length) {
        const graded = scholar.prospectus.subjects.filter(
          (s) => s.grade != null && !isNaN(Number(s.grade)),
        );
        if (graded.length > 0) {
          const totalW = graded.reduce(
            (acc, s) => acc + Number(s.grade) * (Number(s.units) || 3),
            0,
          );
          const totalU = graded.reduce(
            (acc, s) => acc + (Number(s.units) || 3),
            0,
          );
          gwa =
            totalU > 0
              ? Number((totalW / totalU).toFixed(2))
              : Number(graded[0].grade);
        } else {
          gwa = scholar.school_grading_system?.highest_grade
            ? Number(scholar.school_grading_system.highest_grade)
            : scholar.school_grading_system?.grading_scale === 'NUMERIC_5_POINT'
              ? 1.0
              : scholar.school_grading_system?.grading_scale ===
                  'NUMERIC_4_POINT'
                ? 4.0
                : gradeThreshold;
        }
      } else {
        gwa = scholar.school_grading_system?.highest_grade
          ? Number(scholar.school_grading_system.highest_grade)
          : scholar.school_grading_system?.grading_scale === 'NUMERIC_5_POINT'
            ? 1.0
            : scholar.school_grading_system?.grading_scale === 'NUMERIC_4_POINT'
              ? 4.0
              : gradeThreshold;
      }

      // Health Standing with accurate school grading scale
      const health = this.evaluateScholarHealth(
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
          c.messages[0]?.sent_at?.toISOString() || c.updated_at?.toISOString(),
      })),
    };
  }

  /**
   * Evaluates if computed GWA meets retention threshold across different grading scales.
   * e.g., A 90% threshold translates to:
   * - 90.00 on a 100% percentage scale
   * - 3.50 on UM's 4.0 scale (where 2.0 = 75%, 4.0 = 100%, 3.50 = 90%)
   * - 1.80 on USEP / UP 5.0 scale (where 3.0 = 75%, 1.0 = 100%, 1.80 = 90%)
   */
  evaluateGwaThreshold(
    gwa: number,
    globalThresholdPercent: number,
    schoolConfig?: any,
  ): boolean {
    if (!schoolConfig || schoolConfig.grading_scale === 'PERCENTAGE_100') {
      return gwa >= globalThresholdPercent;
    }

    const highest = Number(schoolConfig.highest_grade ?? 1.0);
    const passing = Number(schoolConfig.passing_grade ?? 3.0);
    const failing = Number(schoolConfig.failing_grade ?? 5.0);

    const normalizedPercent = Math.max(
      75,
      Math.min(100, globalThresholdPercent),
    );

    if (highest < failing) {
      // Inverted 5-point scale (e.g. 1.0 highest, 3.0 passing at 75%)
      // 90% translates to: 3.0 - ((90 - 75) / 25) * (3.0 - 1.0) = 1.80
      const thresholdGwa =
        passing - ((normalizedPercent - 75) / 25) * (passing - highest);
      return gwa <= Number(thresholdGwa.toFixed(2));
    } else {
      // Ascending scale (e.g. UM 4.0: 4.0 highest, 2.0 passing at 75%, 3.50 retention at 90%)
      const thresholdGwa =
        normalizedPercent <= 90
          ? passing + ((normalizedPercent - 75) / 15) * 1.5
          : 3.5 + ((normalizedPercent - 90) / 10) * (highest - 3.5);
      return gwa >= Number(thresholdGwa.toFixed(2));
    }
  }

  evaluateScholarHealth(
    gwa: number,
    scholar: any,
    latestReport: any,
    globalThresholdPercent: number,
  ): 'good' | 'warn' | 'bad' {
    const isOnProbation =
      scholar.academic_baseline_status === 'ON_PROBATION' ||
      latestReport?.appeal_status === 'APPROVED';

    const isFlagged =
      latestReport &&
      (latestReport.status === 'FLAGGED' ||
        latestReport.evaluation_flag === 'ACADEMIC_FAILURE' ||
        latestReport.evaluation_flag === 'BELOW_PASSING_MARK' ||
        latestReport.is_eligible === false);

    const schoolConfig = scholar.school_grading_system;
    const highest = Number(
      schoolConfig?.highest_grade ??
        (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
          ? 1.0
          : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
            ? 4.0
            : 100),
    );
    const passing = Number(
      schoolConfig?.passing_grade ??
        (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
          ? 3.0
          : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
            ? 2.0
            : 75),
    );
    const failing = Number(
      schoolConfig?.failing_grade ??
        (schoolConfig?.grading_scale === 'NUMERIC_5_POINT'
          ? 5.0
          : schoolConfig?.grading_scale === 'NUMERIC_4_POINT'
            ? 1.0
            : 50),
    );

    const isInverted = highest < failing;
    const isFailingGrade = isInverted ? gwa > passing : gwa < passing;

    const meetsRetention = this.evaluateGwaThreshold(
      gwa,
      globalThresholdPercent,
      schoolConfig,
    );

    if (isFlagged || (gwa > 0 && isFailingGrade)) {
      return 'bad';
    } else if (isOnProbation || (gwa > 0 && !meetsRetention)) {
      return 'warn';
    }
    return 'good';
  }
}
