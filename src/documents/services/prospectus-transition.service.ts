import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { Role } from '../../generated/prisma/enums.js';
import { evaluateProspectusGraduation } from '../../common/utils/graduation-readiness.util.js';
import {
  Application,
  SchoolGradingSystem,
} from '../../generated/prisma/client.js';

@Injectable()
export class ProspectusTransitionService {
  private readonly logger = new Logger(ProspectusTransitionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly cacheService: AppCacheService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly eventsGateway?: EventsGateway,
  ) {}

  private normalizeSubjectCode(code?: string | null): string {
    if (!code) return '';
    return code
      .trim()
      .toUpperCase()
      .replace(/[\s\-_./\\]+/g, '')
      .replace(/(?<=[A-Z])III$/g, '3')
      .replace(/(?<=[A-Z])II$/g, '2')
      .replace(/(?<=[A-Z])I$/g, '1');
  }

  private normalizeText(text?: string | null): string {
    if (!text) return '';
    return text.trim().toUpperCase().replace(/[^A-Z0-9]/gi, '');
  }

  /**
   * Transitions ENROLLED / UNTAKEN subjects in the scholar's prospectus to PASSED or FAILED
   */
  async transitionProspectusSubjects(
    scholarProfileId: number,
    gradeItems: {
      subject_code?: string;
      subject_name?: string;
      grade: number;
    }[],
    academicYear: string,
    semester: string,
    schoolConfig: SchoolGradingSystem | null,
  ): Promise<void> {
    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
      include: {
        subjects: true,
        scholar_profile: { select: { user_id: true } },
      },
    });

    if (!prospectus || !prospectus.subjects?.length) return;

    const matchedSubjectIds = new Set<number>();

    for (const item of gradeItems) {
      const normCode = this.normalizeSubjectCode(item.subject_code);
      const normTitle = this.normalizeText(item.subject_name);

      // Prioritized matching:
      // Tier 1: Exact code match on an ENROLLED subject for this active term
      let match = prospectus.subjects.find((ps) => {
        if (matchedSubjectIds.has(ps.subject_id)) return false;
        if (ps.status !== 'ENROLLED') return false;
        return normCode && this.normalizeSubjectCode(ps.subject_code) === normCode;
      });

      // Tier 2: Exact code match in the matching semester
      if (!match && normCode) {
        match = prospectus.subjects.find((ps) => {
          if (matchedSubjectIds.has(ps.subject_id)) return false;
          if (ps.semester !== semester) return false;
          return this.normalizeSubjectCode(ps.subject_code) === normCode;
        });
      }

      // Tier 3: Exact code match anywhere in prospectus
      if (!match && normCode) {
        match = prospectus.subjects.find((ps) => {
          if (matchedSubjectIds.has(ps.subject_id)) return false;
          return this.normalizeSubjectCode(ps.subject_code) === normCode;
        });
      }

      // Tier 4: Exact title match on an ENROLLED subject
      if (!match && normTitle) {
        match = prospectus.subjects.find((ps) => {
          if (matchedSubjectIds.has(ps.subject_id)) return false;
          if (ps.status !== 'ENROLLED') return false;
          return this.normalizeText(ps.descriptive_title) === normTitle;
        });
      }

      // Tier 5: Exact title match anywhere in prospectus
      if (!match && normTitle) {
        match = prospectus.subjects.find((ps) => {
          if (matchedSubjectIds.has(ps.subject_id)) return false;
          return this.normalizeText(ps.descriptive_title) === normTitle;
        });
      }

      if (match) {
        matchedSubjectIds.add(match.subject_id);
        const numGrade = Number(item.grade);
        const isPassing = schoolConfig
          ? this.settingsService.evaluateStudentGrade(item.grade, schoolConfig)
              .isPassing
          : !isNaN(numGrade) && (numGrade <= 3.0 || numGrade >= 75.0);

        await this.prisma.prospectusSubject.update({
          where: { subject_id: match.subject_id },
          data: {
            status: isPassing ? 'PASSED' : 'FAILED',
            grade: isNaN(numGrade) ? null : numGrade,
            credited_term: `${academicYear} ${semester}`,
            remarks: `${isPassing ? 'Passed' : 'Failed'} in AY ${academicYear} ${semester}`,
          },
        });
      }
    }

    if (prospectus.scholar_profile?.user_id) {
      await this.cacheService.del(
        `baseline:scholar:${prospectus.scholar_profile.user_id}`,
      );
      await this.cacheService.del(
        `dashboard:scholar:${prospectus.scholar_profile.user_id}`,
      );
    }
    await this.cacheService.del(`baseline:review:${scholarProfileId}`);

    if (matchedSubjectIds.size > 0) {
      try {
        await this.checkAndNotifyGraduationReadiness(scholarProfileId);
      } catch (err) {
        this.logger.warn(
          `Failed graduation readiness check for scholar profile ${scholarProfileId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Checks whether an active scholar's frozen prospectus has reached 100% completion.
   * When ready and not yet notified, sends a confirmation notification to staff.
   */
  async checkAndNotifyGraduationReadiness(
    scholarProfileId: number,
  ): Promise<boolean> {
    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
      include: {
        subjects: true,
        scholar_profile: {
          select: {
            profile_id: true,
            user_id: true,
            first_name: true,
            last_name: true,
            archived_at: true,
            current_year_level: true,
            course_of_study: true,
            user: { select: { role: true, email: true } },
          },
        },
      },
    });

    const profile = prospectus?.scholar_profile as
      | {
          profile_id: number;
          user_id: number;
          first_name?: string | null;
          last_name?: string | null;
          archived_at?: Date | null;
          current_year_level?: number | null;
          course_of_study?: string | null;
          user?: { role?: string | null; email?: string | null } | null;
        }
      | undefined;

    if (!prospectus || !profile) {
      return false;
    }

    if (profile.archived_at) {
      return false;
    }

    if (profile.user?.role && profile.user.role !== 'SCHOLAR') {
      return false;
    }

    const evalResult = evaluateProspectusGraduation(
      prospectus,
      profile.current_year_level ?? 1,
      false,
    );

    if (!evalResult.isReadyForGraduation) {
      return false;
    }

    if (
      typeof (this.prisma as unknown as { notification?: { findFirst?: unknown } })
        .notification?.findFirst === 'function'
    ) {
      const existingUnread = await this.prisma.notification.findFirst({
        where: {
          category: 'graduation_ready',
          is_read: false,
          link: { contains: `/CoordinatorMonitor/${scholarProfileId}` },
        },
      });
      if (existingUnread) {
        return false;
      }
    }

    const studentName =
      `${profile.first_name || ''} ${profile.last_name || ''}`.trim() ||
      profile.user?.email?.split('@')[0] ||
      'Scholar';
    const title = 'Graduation Confirmation Needed';
    const message = `${studentName} has completed 100% of their prospectus (${evalResult.completedUnits}/${evalResult.totalUnits} units). Review and confirm graduation to update their status to Graduated.`;

    if (typeof this.notificationsService?.createForRoles === 'function') {
      await Promise.all([
        this.notificationsService.createForRoles(
          [Role.COORDINATOR, Role.ADMIN],
          {
            title,
            message,
            category: 'graduation_ready',
            link: `/CoordinatorMonitor/${scholarProfileId}?action=confirm-graduation`,
          },
        ),
        this.notificationsService.createForRoles([Role.GRANTOR], {
          title,
          message,
          category: 'graduation_ready',
          link: `/grantMonitor/${scholarProfileId}?action=confirm-graduation`,
        }),
      ]);
    }

    if (typeof this.cacheService?.delPattern === 'function') {
      await this.cacheService.delPattern('sidebar-badges:');
    }

    if (typeof this.eventsGateway?.emitToStaff === 'function') {
      this.eventsGateway.emitToStaff('scholar:graduation_ready', {
        scholarProfileId,
        studentName,
        completionPct: 100,
      });
    }

    return true;
  }

  /**
   * Auto-progress application if in onboarding review
   */
  async checkOnboardingApplication(
    scholarProfileId: number,
    isEligible: boolean,
  ): Promise<Application | null> {
    const profile = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: scholarProfileId },
      include: { user: true },
    });

    if (profile?.user?.role !== 'APPLICANT') return null;

    const application = await this.prisma.application.findFirst({
      where: { scholar_profile_id: scholarProfileId },
      orderBy: { submitted_at: 'desc' },
    });

    if (
      application &&
      ['PENDING', 'UNDER_REVIEW'].includes(application.status)
    ) {
      return this.prisma.application.update({
        where: { application_id: application.application_id },
        data: {
          status: 'UNDER_REVIEW',
          stage: isEligible
            ? 'Document Verification Complete'
            : 'Flagged for Review',
          stage_updated_at: new Date(),
        },
      });
    }

    return null;
  }
}
