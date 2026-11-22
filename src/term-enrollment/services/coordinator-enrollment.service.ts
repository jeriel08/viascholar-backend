import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { Role } from '../../generated/prisma/enums.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import {
  BatchEndorseEnrollmentsDto,
  EnrollmentReviewAction,
  ReviewEnrollmentDto,
} from '../dto/review-enrollment.dto.js';
import { EnrollmentOcrService } from './enrollment-ocr.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';

@Injectable()
export class CoordinatorEnrollmentService {
  private readonly logger = new Logger(CoordinatorEnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
    private readonly enrollmentOcrService: EnrollmentOcrService,
    private readonly cacheService: AppCacheService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  private async getCoordinatorEmployee(userId: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: userId },
    });
    if (!employee) {
      throw new NotFoundException('Coordinator employee record not found.');
    }
    return employee;
  }

  private async markEnrollmentDocsVerified(
    tx: any,
    enrollment: {
      cor_document_id?: number | null;
      soa_document_id?: number | null;
    },
    coordinatorEmployeeId: number,
  ) {
    if (enrollment.cor_document_id) {
      await tx.scholarDocument.update({
        where: { document_id: enrollment.cor_document_id },
        data: {
          status: 'VERIFIED',
          verified_at: new Date(),
          reviewed_by_employee_id: coordinatorEmployeeId,
        },
      });
    }
    if (
      enrollment.soa_document_id &&
      enrollment.soa_document_id !== enrollment.cor_document_id
    ) {
      await tx.scholarDocument.update({
        where: { document_id: enrollment.soa_document_id },
        data: {
          status: 'VERIFIED',
          verified_at: new Date(),
          reviewed_by_employee_id: coordinatorEmployeeId,
        },
      });
    }
  }

  private async endorseEnrollmentInTx(
    tx: any,
    enrollment: any,
    coordinator: { employee_id: number },
    opts: {
      approvedAmount: number;
      coordinatorNotes?: string;
      adjustedSubjects?: any[];
    },
  ) {
    const disbursement = await tx.disbursement.create({
      data: {
        scholar_profile_id: enrollment.scholar_profile_id,
        academic_year: enrollment.academic_year,
        semester: enrollment.semester,
        amount: opts.approvedAmount,
        status: 'PENDING',
        approved_by_employee_id: coordinator.employee_id,
        remarks:
          `Tuition & fees disbursement endorsed from Start-of-Term Enrollment Audit. ${opts.coordinatorNotes || ''}`.trim(),
      },
    });

    const updatedEnrollment = await tx.termEnrollment.update({
      where: { enrollment_id: enrollment.enrollment_id },
      data: {
        status: 'APPROVED',
        reviewed_by_employee_id: coordinator.employee_id,
        reviewed_at: new Date(),
        coordinator_notes: opts.coordinatorNotes,
        disbursement_id: disbursement.disbursement_id,
        enrolled_subjects: (opts.adjustedSubjects ??
          enrollment.enrolled_subjects) as any,
      },
    });

    const enrolledSubs = (opts.adjustedSubjects ??
      enrollment.enrolled_subjects) as any[];
    if (
      Array.isArray(enrolledSubs) &&
      enrollment.scholar_profile?.prospectus
    ) {
      const prospectusSubjects =
        enrollment.scholar_profile.prospectus.subjects || [];
      const normalizeTitle = (title: string) =>
        (title || '')
          .toLowerCase()
          .replace(/\b(lab|laboratory|lec|lecture)\b/g, '')
          .replace(/[^a-z0-9]/g, '')
          .trim();

      for (const sub of enrolledSubs) {
        const normCode = this.enrollmentOcrService.normalizeSubjectCode(
          sub.subject_code,
        );
        let matchingSubject = prospectusSubjects.find(
          (ps: any) =>
            this.enrollmentOcrService.normalizeSubjectCode(ps.subject_code) ===
            normCode,
        );

        if (!matchingSubject && sub.curriculum_subject_id) {
          matchingSubject = prospectusSubjects.find(
            (ps: any) => ps.subject_id === Number(sub.curriculum_subject_id),
          );
        }

        if (
          !matchingSubject &&
          typeof (this.enrollmentOcrService as any).getBaseSubjectCode ===
            'function'
        ) {
          const baseCode = (
            this.enrollmentOcrService as any
          ).getBaseSubjectCode(sub.subject_code);
          if (baseCode) {
            matchingSubject =
              prospectusSubjects.find(
                (ps: any) =>
                  (this.enrollmentOcrService as any).getBaseSubjectCode(
                    ps.subject_code,
                  ) === baseCode && ps.status === 'UNTAKEN',
              ) ||
              prospectusSubjects.find(
                (ps: any) =>
                  (this.enrollmentOcrService as any).getBaseSubjectCode(
                    ps.subject_code,
                  ) === baseCode,
              );
          }
        }

        if (!matchingSubject && sub.descriptive_title) {
          const normTitle = normalizeTitle(sub.descriptive_title);
          if (normTitle.length > 3) {
            matchingSubject =
              prospectusSubjects.find(
                (ps: any) =>
                  ps.descriptive_title &&
                  normalizeTitle(ps.descriptive_title) === normTitle &&
                  ps.status === 'UNTAKEN',
              ) ||
              prospectusSubjects.find(
                (ps: any) =>
                  ps.descriptive_title &&
                  normalizeTitle(ps.descriptive_title) === normTitle,
              );
          }
        }

        if (matchingSubject && matchingSubject.status === 'UNTAKEN') {
          await tx.prospectusSubject.update({
            where: { subject_id: matchingSubject.subject_id },
            data: {
              status: 'ENROLLED',
              remarks: `Enrolled in ${enrollment.academic_year} ${enrollment.semester}`,
            },
          });
          matchingSubject.status = 'ENROLLED';
        }
      }
    }

    await this.markEnrollmentDocsVerified(
      tx,
      enrollment,
      coordinator.employee_id,
    );

    return { updatedEnrollment, disbursement };
  }

  // 1. Get queue of term enrollments pending review
  async getPendingEnrollments(search?: string, status?: string) {
    const where: any = {};
    if (status && status !== 'ALL') {
      where.status = status;
    } else {
      where.status = { not: 'DRAFT' };
    }

    if (search) {
      where.scholar_profile = {
        OR: [
          { first_name: { contains: search, mode: 'insensitive' } },
          { last_name: { contains: search, mode: 'insensitive' } },
          { student_number: { contains: search, mode: 'insensitive' } },
          { school_name: { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const enrollments = await this.prisma.termEnrollment.findMany({
      where,
      orderBy: { updated_at: 'desc' },
      include: {
        scholar_profile: {
          include: {
            school_grading_system: true,
          },
        },
        cor_document: true,
        soa_document: true,
        reviewed_by_employee: {
          select: {
            employee_id: true,
            first_name: true,
            last_name: true,
            title: true,
          },
        },
        disbursement: true,
      },
    });

    if (Array.isArray(enrollments)) {
      for (const item of enrollments) {
        if (
          item.status === 'COMPLETED' &&
          (item as any).reviewed_by_employee_id === null &&
          (item as any).disbursement_id === null &&
          typeof item.coordinator_notes === 'string' &&
          item.coordinator_notes.includes('Term concluded with CCG submission.')
        ) {
          await this.prisma.termEnrollment.update({
            where: { enrollment_id: item.enrollment_id },
            data: {
              status: 'PENDING_REVIEW',
              coordinator_notes: null,
            },
          });
          item.status = 'PENDING_REVIEW';
          item.coordinator_notes = null;
        }
      }
    }

    return enrollments;
  }

  // 2. Get specific enrollment details for side-by-side quick audit
  async getEnrollmentDetails(enrollmentId: number) {
    const enrollment = await this.prisma.termEnrollment.findUnique({
      where: { enrollment_id: enrollmentId },
      include: {
        scholar_profile: {
          include: {
            school_grading_system: true,
            prospectus: {
              include: {
                subjects: {
                  orderBy: [
                    { year_level: 'asc' },
                    { semester: 'asc' },
                    { subject_code: 'asc' },
                  ],
                },
              },
            },
          },
        },
        cor_document: true,
        soa_document: true,
        reviewed_by_employee: true,
        disbursement: true,
      },
    });

    if (!enrollment) {
      throw new NotFoundException(
        `Term enrollment #${enrollmentId} not found.`,
      );
    }

    if (
      enrollment.status === 'COMPLETED' &&
      (enrollment as any).reviewed_by_employee_id === null &&
      (enrollment as any).disbursement_id === null &&
      typeof enrollment.coordinator_notes === 'string' &&
      enrollment.coordinator_notes.includes(
        'Term concluded with CCG submission.',
      )
    ) {
      await this.prisma.termEnrollment.update({
        where: { enrollment_id: enrollment.enrollment_id },
        data: {
          status: 'PENDING_REVIEW',
          coordinator_notes: null,
        },
      });
      enrollment.status = 'PENDING_REVIEW';
      enrollment.coordinator_notes = null;
    }

    return enrollment;
  }

  // 3. Review, endorse or request changes
  async reviewEnrollment(
    userId: number,
    enrollmentId: number,
    dto: ReviewEnrollmentDto,
  ) {
    const coordinator = await this.getCoordinatorEmployee(userId);
    const enrollment = await this.prisma.termEnrollment.findUnique({
      where: { enrollment_id: enrollmentId },
      include: {
        scholar_profile: {
          include: {
            prospectus: { include: { subjects: true } },
          },
        },
      },
    });

    if (!enrollment) {
      throw new NotFoundException(
        `Term enrollment #${enrollmentId} not found.`,
      );
    }

    if (
      enrollment.status === 'COMPLETED' &&
      (enrollment as any).reviewed_by_employee_id === null &&
      (enrollment as any).disbursement_id === null &&
      typeof enrollment.coordinator_notes === 'string' &&
      enrollment.coordinator_notes.includes(
        'Term concluded with CCG submission.',
      )
    ) {
      enrollment.status = 'PENDING_REVIEW';
      enrollment.coordinator_notes = null;
    }

    if (enrollment.status === 'APPROVED' || enrollment.status === 'COMPLETED') {
      throw new BadRequestException(
        `Term enrollment #${enrollmentId} has already been reviewed and endorsed.`,
      );
    }

    if (dto.action === EnrollmentReviewAction.VERIFY) {
      const verifiedAmount =
        dto.approved_amount ?? Number(enrollment.total_assessment);

      const updatedEnrollment = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.termEnrollment.update({
          where: { enrollment_id: enrollmentId },
          data: {
            status: 'VERIFIED',
            reviewed_by_employee_id: coordinator.employee_id,
            reviewed_at: new Date(),
            coordinator_notes:
              dto.coordinator_notes !== undefined
                ? dto.coordinator_notes
                : enrollment.coordinator_notes,
            total_assessment: verifiedAmount,
            enrolled_subjects: (dto.adjusted_subjects ??
              enrollment.enrolled_subjects) as any,
          },
        });

        await this.markEnrollmentDocsVerified(
          tx,
          enrollment,
          coordinator.employee_id,
        );

        return updated;
      });

      await this.auditService.log(
        userId,
        'VERIFY_TERM_ENROLLMENT',
        `Verified enrollment #${enrollmentId} for Scholar #${enrollment.scholar_profile_id} (PHP ${verifiedAmount}, awaiting batch endorsement to Grantor)`,
      );

      if (enrollment.scholar_profile) {
        this.eventsGateway.emitToUser(
          enrollment.scholar_profile.user_id,
          'enrollment:verified',
          {
            enrollment_id: enrollmentId,
            scholar_id: enrollment.scholar_profile_id,
            status: 'VERIFIED',
          },
        );
        await this.cacheService.del(
          `baseline:scholar:${enrollment.scholar_profile.user_id}`,
        );
        await this.cacheService.del(
          `baseline:review:${enrollment.scholar_profile.profile_id}`,
        );
        await this.cacheService.del(
          `dashboard:scholar:${enrollment.scholar_profile.user_id}`,
        );
      }
      this.eventsGateway.emitToStaff('enrollment:verified', {
        enrollment_id: enrollmentId,
        scholar_id: enrollment.scholar_profile_id,
        status: 'VERIFIED',
      });
      await this.cacheService.delPattern('dashboard:coordinator:');

      return {
        message:
          'Term enrollment verified and ready for Grantor endorsement.',
        enrollment: updatedEnrollment,
      };
    }

    if (dto.action === EnrollmentReviewAction.APPROVE) {
      const approvedAmount =
        dto.approved_amount ?? Number(enrollment.total_assessment);

      // Create Disbursement in transaction
      const result = await this.prisma.$transaction(async (tx) =>
        this.endorseEnrollmentInTx(tx, enrollment, coordinator, {
          approvedAmount,
          coordinatorNotes: dto.coordinator_notes,
          adjustedSubjects: dto.adjusted_subjects,
        }),
      );

      await this.auditService.log(
        userId,
        'APPROVE_TERM_ENROLLMENT',
        `Approved enrollment #${enrollmentId} for Scholar #${enrollment.scholar_profile_id} and queued disbursement of PHP ${approvedAmount}`,
      );

      // Emit real-time events
      this.eventsGateway.emitToStaff('disbursement:created', {
        disbursement_id: result.disbursement.disbursement_id,
        scholar_id: enrollment.scholar_profile_id,
        amount: approvedAmount,
        academic_year: enrollment.academic_year,
        semester: enrollment.semester,
      });

      this.eventsGateway.emitToUser(
        enrollment.scholar_profile.user_id,
        'enrollment:approved',
        {
          enrollment_id: enrollmentId,
          scholar_id: enrollment.scholar_profile_id,
          disbursement_id: result.disbursement.disbursement_id,
        },
      );
      this.eventsGateway.emitToStaff('enrollment:approved', {
        enrollment_id: enrollmentId,
        scholar_id: enrollment.scholar_profile_id,
        disbursement_id: result.disbursement.disbursement_id,
      });

      if (enrollment.scholar_profile) {
        await this.cacheService.del(
          `baseline:scholar:${enrollment.scholar_profile.user_id}`,
        );
        await this.cacheService.del(
          `baseline:review:${enrollment.scholar_profile.profile_id}`,
        );
        await this.cacheService.del(
          `dashboard:scholar:${enrollment.scholar_profile.user_id}`,
        );
      }
      await this.cacheService.delPattern('dashboard:coordinator:');
      await this.cacheService.delPattern('dashboard:grantor:');

      return {
        message:
          'Term enrollment approved and endorsed to Grantor disbursement queue.',
        enrollment: result.updatedEnrollment,
        disbursement: result.disbursement,
      };
    } else if (dto.action === EnrollmentReviewAction.REQUEST_CHANGES) {
      const updated = await this.prisma.termEnrollment.update({
        where: { enrollment_id: enrollmentId },
        data: {
          status: 'CHANGES_REQUESTED',
          reviewed_by_employee_id: coordinator.employee_id,
          reviewed_at: new Date(),
          coordinator_notes: dto.coordinator_notes,
        },
      });

      const termRemark = `Enrolled in ${enrollment.academic_year} ${enrollment.semester}`;
      const subjectsToRevert = (
        enrollment.scholar_profile?.prospectus?.subjects || []
      ).filter(
        (ps: any) => ps.status === 'ENROLLED' && ps.remarks === termRemark,
      );
      if (subjectsToRevert.length > 0) {
        for (const ps of subjectsToRevert) {
          await this.prisma.prospectusSubject.update({
            where: { subject_id: ps.subject_id },
            data: { status: 'UNTAKEN', remarks: null },
          });
        }
        await this.cacheService.del(
          `baseline:scholar:${enrollment.scholar_profile.user_id}`,
        );
        await this.cacheService.del(
          `baseline:review:${enrollment.scholar_profile.profile_id}`,
        );
      }

      await this.auditService.log(
        userId,
        'REQUEST_CHANGES_TERM_ENROLLMENT',
        `Requested changes for enrollment #${enrollmentId}: ${dto.coordinator_notes || 'No notes'}`,
      );

      this.eventsGateway.emitToUser(
        enrollment.scholar_profile.user_id,
        'enrollment:changes_requested',
        {
          enrollment_id: enrollmentId,
          scholar_id: enrollment.scholar_profile_id,
          notes: dto.coordinator_notes,
        },
      );
      this.eventsGateway.emitToStaff('enrollment:changes_requested', {
        enrollment_id: enrollmentId,
        scholar_id: enrollment.scholar_profile_id,
        notes: dto.coordinator_notes,
      });

      return {
        message: 'Changes requested from scholar.',
        enrollment: updated,
      };
    } else {
      const updated = await this.prisma.termEnrollment.update({
        where: { enrollment_id: enrollmentId },
        data: {
          status: 'REJECTED',
          reviewed_by_employee_id: coordinator.employee_id,
          reviewed_at: new Date(),
          coordinator_notes: dto.coordinator_notes,
        },
      });

      const termRemark = `Enrolled in ${enrollment.academic_year} ${enrollment.semester}`;
      const subjectsToRevert = (
        enrollment.scholar_profile?.prospectus?.subjects || []
      ).filter(
        (ps: any) => ps.status === 'ENROLLED' && ps.remarks === termRemark,
      );
      if (subjectsToRevert.length > 0) {
        for (const ps of subjectsToRevert) {
          await this.prisma.prospectusSubject.update({
            where: { subject_id: ps.subject_id },
            data: { status: 'UNTAKEN', remarks: null },
          });
        }
        await this.cacheService.del(
          `baseline:scholar:${enrollment.scholar_profile.user_id}`,
        );
        await this.cacheService.del(
          `baseline:review:${enrollment.scholar_profile.profile_id}`,
        );
      }

      await this.auditService.log(
        userId,
        'REJECT_TERM_ENROLLMENT',
        `Rejected enrollment #${enrollmentId}: ${dto.coordinator_notes || 'No notes'}`,
      );

      this.eventsGateway.emitToUser(
        enrollment.scholar_profile.user_id,
        'enrollment:rejected',
        {
          enrollment_id: enrollmentId,
          scholar_id: enrollment.scholar_profile_id,
          notes: dto.coordinator_notes,
        },
      );
      this.eventsGateway.emitToStaff('enrollment:rejected', {
        enrollment_id: enrollmentId,
        scholar_id: enrollment.scholar_profile_id,
        notes: dto.coordinator_notes,
      });

      return {
        message: 'Term enrollment rejected.',
        enrollment: updated,
      };
    }
  }

  // 4. Grantor authorizes disbursement for approved term enrollment
  async grantorAuthorizeDisbursement(
    userId: number,
    enrollmentId: number,
    dto?: { remarks?: string; check_number?: string; payment_method?: string },
  ) {
    const enrollment = await this.prisma.termEnrollment.findUnique({
      where: { enrollment_id: enrollmentId },
      include: {
        disbursement: true,
        scholar_profile: true,
      },
    });

    if (!enrollment) {
      throw new NotFoundException(
        `Term enrollment #${enrollmentId} not found.`,
      );
    }

    if (!enrollment.disbursement_id || !enrollment.disbursement) {
      throw new BadRequestException(
        'No pending disbursement found for this enrollment.',
      );
    }

    const updatedDisbursement = await this.prisma.disbursement.update({
      where: { disbursement_id: enrollment.disbursement_id },
      data: {
        status: 'RELEASED',
        date_issued: new Date(),
        check_number: dto?.check_number,
        payment_method: dto?.payment_method || 'BANK_TRANSFER',
        remarks: dto?.remarks
          ? `${enrollment.disbursement.remarks || ''}\nGrantor Authorization: ${dto.remarks}`.trim()
          : enrollment.disbursement.remarks,
      },
    });

    await this.auditService.log(
      userId,
      'GRANTOR_APPROVE_DISBURSEMENT',
      `Grantor authorized disbursement #${updatedDisbursement.disbursement_id} of PHP ${updatedDisbursement.amount} for scholar #${enrollment.scholar_profile_id}`,
    );

    this.eventsGateway.emitToStaff('disbursement:updated', {
      disbursement_id: updatedDisbursement.disbursement_id,
      status: 'RELEASED',
      scholar_id: enrollment.scholar_profile_id,
    });
    this.eventsGateway.emitToUser(
      enrollment.scholar_profile.user_id,
      'disbursement:updated',
      {
        disbursement_id: updatedDisbursement.disbursement_id,
        status: 'RELEASED',
        amount: updatedDisbursement.amount,
      },
    );

    return {
      message: 'Disbursement authorized and marked as released.',
      disbursement: updatedDisbursement,
    };
  }

  // 5. Approach A: Endorse a batch of Coordinator-verified enrollments to Grantor
  async batchEndorseEnrollments(
    userId: number,
    dto: BatchEndorseEnrollmentsDto,
  ) {
    const coordinator = await this.getCoordinatorEmployee(userId);
    const uniqueIds = Array.from(new Set(dto.enrollment_ids.map(Number)));

    const enrollments = await this.prisma.termEnrollment.findMany({
      where: { enrollment_id: { in: uniqueIds } },
      include: {
        scholar_profile: {
          include: {
            prospectus: { include: { subjects: true } },
          },
        },
      },
    });

    if (!enrollments || enrollments.length === 0) {
      throw new NotFoundException('No matching term enrollments found.');
    }

    const foundIds = new Set(enrollments.map((e) => e.enrollment_id));
    const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      throw new NotFoundException(
        `Term enrollment(s) not found: ${missingIds.join(', ')}.`,
      );
    }

    const unverified = enrollments.filter((e) => e.status !== 'VERIFIED');
    if (unverified.length > 0) {
      throw new BadRequestException(
        `All selected enrollments must be verified by the Coordinator before batch endorsement. Non-verified ID(s): ${unverified.map((e) => e.enrollment_id).join(', ')}.`,
      );
    }

    const batchNotes = dto.coordinator_notes?.trim();
    const txResults = await this.prisma.$transaction(async (tx) => {
      const items: Array<{
        enrollment: any;
        updatedEnrollment: any;
        disbursement: any;
        approvedAmount: number;
      }> = [];
      for (const enrollment of enrollments) {
        const approvedAmount = Number(enrollment.total_assessment) || 0;
        const mergedNotes = [enrollment.coordinator_notes, batchNotes]
          .filter((n) => typeof n === 'string' && n.trim().length > 0)
          .join(' | ');
        const res = await this.endorseEnrollmentInTx(
          tx,
          enrollment,
          coordinator,
          {
            approvedAmount,
            coordinatorNotes: mergedNotes || undefined,
          },
        );
        items.push({
          enrollment,
          updatedEnrollment: res.updatedEnrollment,
          disbursement: res.disbursement,
          approvedAmount,
        });
      }
      return items;
    });

    const totalAmount = txResults.reduce(
      (sum, item) => sum + item.approvedAmount,
      0,
    );
    const endorsedCount = txResults.length;

    await this.auditService.log(
      userId,
      'BATCH_ENDORSE_TERM_ENROLLMENTS',
      `Batch endorsed ${endorsedCount} verified enrollment(s) to Grantor totaling PHP ${totalAmount.toFixed(2)} (IDs: ${uniqueIds.join(', ')}).`,
    );

    for (const item of txResults) {
      const { enrollment, disbursement, approvedAmount } = item;
      this.eventsGateway.emitToStaff('disbursement:created', {
        disbursement_id: disbursement.disbursement_id,
        scholar_id: enrollment.scholar_profile_id,
        amount: approvedAmount,
        academic_year: enrollment.academic_year,
        semester: enrollment.semester,
      });
      if (enrollment.scholar_profile?.user_id) {
        this.eventsGateway.emitToUser(
          enrollment.scholar_profile.user_id,
          'enrollment:approved',
          {
            enrollment_id: enrollment.enrollment_id,
            scholar_id: enrollment.scholar_profile_id,
            disbursement_id: disbursement.disbursement_id,
          },
        );
      }
      this.eventsGateway.emitToStaff('enrollment:approved', {
        enrollment_id: enrollment.enrollment_id,
        scholar_id: enrollment.scholar_profile_id,
        disbursement_id: disbursement.disbursement_id,
      });
    }

    if (this.notificationsService) {
      try {
        const termLabel = `${txResults[0].enrollment.academic_year} ${txResults[0].enrollment.semester}`;
        const formattedTotal = new Intl.NumberFormat('en-PH', {
          style: 'currency',
          currency: 'PHP',
        }).format(totalAmount);
        await this.notificationsService.createForRoles(
          [Role.GRANTOR, Role.ADMIN],
          {
            title: `Batch Tuition Endorsement (${endorsedCount})`,
            message: `${endorsedCount} verified scholar enrollment${endorsedCount === 1 ? '' : 's'} for ${termLabel} (${formattedTotal} total) ${endorsedCount === 1 ? 'was' : 'were'} endorsed to your disbursement queue.`,
            category: 'disbursement',
            link: '/grantPayment',
          },
        );

        await Promise.all(
          txResults
            .filter((item) => Boolean(item.enrollment.scholar_profile?.user_id))
            .map((item) =>
              this.notificationsService!.notifyUser(
                item.enrollment.scholar_profile.user_id,
                {
                  title: 'Enrollment Endorsed to Grantor',
                  message: `Your enrollment for A.Y. ${item.enrollment.academic_year} ${item.enrollment.semester} has been endorsed to the Grantor for tuition release.`,
                  category: 'enrollment',
                  link: '/scholar-enrollment',
                },
              ),
            ),
        );
      } catch (err) {
        this.logger.warn(
          `Failed to send batch endorsement notifications: ${err}`,
        );
      }
    }

    await Promise.all(
      txResults.flatMap((item) => {
        const profile = item.enrollment.scholar_profile;
        if (!profile) return [];
        return [
          this.cacheService.del(`baseline:scholar:${profile.user_id}`),
          this.cacheService.del(`baseline:review:${profile.profile_id}`),
          this.cacheService.del(`dashboard:scholar:${profile.user_id}`),
        ];
      }),
    );
    await this.cacheService.delPattern('dashboard:coordinator:');
    await this.cacheService.delPattern('dashboard:grantor:');

    return {
      message: `Endorsed ${endorsedCount} verified enrollment${endorsedCount === 1 ? '' : 's'} to Grantor.`,
      endorsed_count: endorsedCount,
      total_amount: totalAmount,
      enrollments: txResults.map((i) => i.updatedEnrollment),
      disbursements: txResults.map((i) => i.disbursement),
    };
  }
}
