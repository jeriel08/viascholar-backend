import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { Role } from '../../generated/prisma/enums.js';

const PROHIBITED_GRADE_DOC_REGEX =
  /^(tor|transcript|form\s*138|form\s*137|form\s*9|sf9|report\s*card|soa|cor|statement_of_account|certificate_of_registration|official_receipt|receipt|consolidated|prospectus|curriculum|historical)/i;

export interface SidebarBadgesResult {
  applicants: number | null;
  meetings: number | null;
  scholars: number | null;
  disbursements: number | string | null;
  schools: number | null;
  programs: number | null;
  graduationConfirmations?: number | null;
}

@Injectable()
export class SidebarBadgesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: AppCacheService,
  ) {}

  private async countPendingGraduationConfirmations(): Promise<number> {
    if (typeof this.prisma.scholarProfile?.count !== 'function') {
      return 0;
    }
    return this.prisma.scholarProfile.count({
      where: {
        archived_at: null,
        user: { role: Role.SCHOLAR, is_active: true },
        prospectus: {
          is: {
            is_frozen: true,
            subjects: {
              some: {},
              none: { status: { notIn: ['PASSED', 'CREDITED'] } },
            },
          },
        },
      },
    });
  }

  private countValidScholarGradeDocs(
    docs: Array<{ document_type: string; label: string | null }>,
  ): number {
    let count = 0;
    for (const g of docs) {
      const type = (g.document_type || '').trim();
      const label = (g.label || '').trim();
      if (
        !PROHIBITED_GRADE_DOC_REGEX.test(type) &&
        !PROHIBITED_GRADE_DOC_REGEX.test(label)
      ) {
        count += 1;
      }
    }
    return count;
  }

  async getSidebarBadges(
    user: {
      user_id: number;
      role: string;
      scholar_profile?: { profile_id?: number } | null;
    },
    forceRefresh = false,
  ): Promise<SidebarBadgesResult> {
    const role = (user.role || '').toUpperCase();
    const isStaff =
      role === 'ADMIN' || role === 'COORDINATOR' || role === 'GRANTOR';
    const cacheKey = isStaff
      ? `sidebar-badges:${role}`
      : `sidebar-badges:${role}:${user.user_id}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const now = new Date();

        if (isStaff) {
          const commonStaffQueries = [
            this.prisma.school.count({
              where: { is_active: false, archived_at: null },
            }),
            this.prisma.academicProgram.count({
              where: { is_active: false, archived_at: null },
            }),
            this.prisma.application.count({
              where: {
                stage: { not: 'Draft' },
                archived_at: null,
                status: { not: 'REJECTED' },
                NOT: {
                  AND: [
                    {
                      OR: [
                        { status: 'APPROVED' },
                        { stage: { equals: 'accepted', mode: 'insensitive' } },
                      ],
                    },
                    { scholar_profile: { contracts: { some: {} } } },
                  ],
                },
              },
            }),
            this.prisma.meeting.count({
              where: {
                status: { in: ['SCHEDULED', 'RESCHEDULED'] },
                scheduled_at: { gte: now },
              },
            }),
          ] as const;

          if (role === 'GRANTOR') {
            const [
              [schools, programs, applicants, meetings],
              pendingEnrollments,
              pendingDisbursements,
              pendingAppeals,
              pendingGraduationConfirmations,
            ] = await Promise.all([
              Promise.all(commonStaffQueries),
              this.prisma.termEnrollment.count({
                where: {
                  status: 'APPROVED',
                  OR: [
                    { disbursement_id: null },
                    { disbursement: { is: { status: 'PENDING' } } },
                  ],
                },
              }),
              this.prisma.disbursement.count({
                where: { status: 'PENDING' },
              }),
              this.prisma.gradeReport.count({
                where: { appeal_status: 'PENDING_GRANTOR' },
              }),
              this.countPendingGraduationConfirmations(),
            ]);

            return {
              applicants,
              meetings,
              scholars:
                pendingEnrollments +
                pendingAppeals +
                pendingGraduationConfirmations,
              disbursements: pendingDisbursements,
              schools,
              programs,
              graduationConfirmations: pendingGraduationConfirmations,
            };
          }

          if (role === 'COORDINATOR') {
            const [
              [schools, programs, applicants, meetings],
              pendingBaselines,
              pendingEnrollments,
              pendingDisbursements,
              gradeDocs,
              pendingGraduationConfirmations,
            ] = await Promise.all([
              Promise.all(commonStaffQueries),
              this.prisma.scholarProfile.count({
                where: {
                  academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
                },
              }),
              this.prisma.termEnrollment.count({
                where: { status: 'PENDING_REVIEW' },
              }),
              this.prisma.disbursement.count({
                where: {
                  status: { in: ['AUTHORIZED', 'RELEASED', 'OR_SUBMITTED'] },
                },
              }),
              this.prisma.scholarDocument.findMany({
                where: {
                  scholar_profile: { user: { role: Role.SCHOLAR } },
                  status: {
                    in: ['PENDING', 'STUDENT_CONFIRMED', 'PASSED_PRECHECK'],
                  },
                },
                select: { document_type: true, label: true },
              }),
              this.countPendingGraduationConfirmations(),
            ]);

            const pendingGradeAudits =
              this.countValidScholarGradeDocs(gradeDocs);

            return {
              applicants,
              meetings,
              scholars:
                pendingBaselines +
                pendingEnrollments +
                pendingGradeAudits +
                pendingGraduationConfirmations,
              disbursements: pendingDisbursements,
              schools,
              programs,
              graduationConfirmations: pendingGraduationConfirmations,
            };
          }

          const [
            [schools, programs, applicants, meetings],
            pendingBaselines,
            pendingEnrollments,
            pendingDisbursements,
            gradeDocs,
            pendingAppeals,
            pendingGraduationConfirmations,
          ] = await Promise.all([
            Promise.all(commonStaffQueries),
            this.prisma.scholarProfile.count({
              where: {
                academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
              },
            }),
            this.prisma.termEnrollment.count({
              where: {
                OR: [
                  { status: 'PENDING_REVIEW' },
                  {
                    status: 'APPROVED',
                    OR: [
                      { disbursement_id: null },
                      { disbursement: { is: { status: 'PENDING' } } },
                    ],
                  },
                ],
              },
            }),
            this.prisma.disbursement.count({
              where: {
                status: { in: ['PENDING', 'AUTHORIZED', 'OR_SUBMITTED'] },
              },
            }),
            this.prisma.scholarDocument.findMany({
              where: {
                scholar_profile: { user: { role: Role.SCHOLAR } },
                status: { in: ['PENDING', 'STUDENT_CONFIRMED'] },
              },
              select: { document_type: true, label: true },
            }),
            this.prisma.gradeReport.count({
              where: { appeal_status: 'PENDING_GRANTOR' },
            }),
            this.countPendingGraduationConfirmations(),
          ]);

          const pendingGradeAudits = this.countValidScholarGradeDocs(gradeDocs);

          return {
            applicants,
            meetings,
            scholars:
              pendingBaselines +
              pendingEnrollments +
              pendingGradeAudits +
              pendingAppeals +
              pendingGraduationConfirmations,
            disbursements: pendingDisbursements,
            schools,
            programs,
            graduationConfirmations: pendingGraduationConfirmations,
          };
        }

        const profileId =
          user.scholar_profile?.profile_id ??
          (
            await this.prisma.scholarProfile.findUnique({
              where: { user_id: user.user_id },
              select: { profile_id: true },
            })
          )?.profile_id ??
          null;

        if (!profileId) {
          return {
            applicants: null,
            meetings: 0,
            scholars: null,
            disbursements: null,
            schools: null,
            programs: null,
            graduationConfirmations: null,
          };
        }

        const [meetings, needsOrCount] = await Promise.all([
          this.prisma.meeting.count({
            where: {
              status: { in: ['SCHEDULED', 'RESCHEDULED'] },
              scheduled_at: { gte: now },
              OR: [
                { scholar_profile_id: profileId },
                { application: { scholar_profile_id: profileId } },
              ],
            },
          }),
          role === 'SCHOLAR'
            ? this.prisma.disbursement.count({
                where: {
                  scholar_profile_id: profileId,
                  status: { in: ['CHECK_ISSUED', 'CLAIMED', 'RELEASED'] },
                  or_document_id: null,
                },
              })
            : Promise.resolve(0),
        ]);

        return {
          applicants: null,
          meetings,
          scholars: null,
          disbursements: role === 'SCHOLAR' && needsOrCount > 0 ? '!' : null,
          schools: null,
          programs: null,
          graduationConfirmations: null,
        };
      },
      30 * 1000,
      forceRefresh,
    );
  }
}
