import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import {
  Application,
  SchoolGradingSystem,
} from '../../generated/prisma/client.js';

@Injectable()
export class ProspectusTransitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly cacheService: AppCacheService,
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
