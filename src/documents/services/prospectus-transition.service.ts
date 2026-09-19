import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { Application, SchoolGradingSystem } from '../../generated/prisma/client.js';

@Injectable()
export class ProspectusTransitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Transitions ENROLLED / UNTAKEN subjects in the scholar's prospectus to PASSED or FAILED
   */
  async transitionProspectusSubjects(
    scholarProfileId: number,
    gradeItems: { subject_code?: string; subject_name?: string; grade: number }[],
    academicYear: string,
    semester: string,
    schoolConfig: SchoolGradingSystem | null,
  ): Promise<void> {
    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
      include: { subjects: true },
    });

    if (!prospectus || !prospectus.subjects?.length) return;

    const clean = (s?: string | null) =>
      (s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

    for (const item of gradeItems) {
      const normCode = clean(item.subject_code);
      const normName = clean(item.subject_name);

      const match = prospectus.subjects.find((ps) => {
        const psCode = clean(ps.subject_code);
        const psTitle = clean(ps.descriptive_title);
        if (
          normCode &&
          psCode &&
          (psCode === normCode ||
            psCode.includes(normCode) ||
            normCode.includes(psCode))
        )
          return true;
        if (
          normName &&
          psTitle &&
          (psTitle === normName ||
            psTitle.includes(normName) ||
            normName.includes(psTitle))
        )
          return true;
        if (
          normCode &&
          psTitle &&
          (psTitle === normCode || psTitle.includes(normCode))
        )
          return true;
        return false;
      });

      if (match) {
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
