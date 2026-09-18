import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import {
  EnrollmentReviewAction,
  ReviewEnrollmentDto,
} from '../dto/review-enrollment.dto.js';
import { EnrollmentOcrService } from './enrollment-ocr.service.js';

@Injectable()
export class CoordinatorEnrollmentService {
  private readonly logger = new Logger(CoordinatorEnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
    private readonly enrollmentOcrService: EnrollmentOcrService,
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
      throw new NotFoundException(`Term enrollment #${enrollmentId} not found.`);
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
      throw new NotFoundException(`Term enrollment #${enrollmentId} not found.`);
    }

    if (dto.action === EnrollmentReviewAction.APPROVE) {
      const approvedAmount = dto.approved_amount ?? Number(enrollment.total_assessment);

      // Create Disbursement in transaction
      const result = await this.prisma.$transaction(async (tx) => {
        // 1. Create pending disbursement for Grantor
        const disbursement = await tx.disbursement.create({
          data: {
            scholar_profile_id: enrollment.scholar_profile_id,
            academic_year: enrollment.academic_year,
            semester: enrollment.semester,
            amount: approvedAmount,
            status: 'PENDING',
            approved_by_employee_id: coordinator.employee_id,
            remarks: `Tuition & fees disbursement endorsed from Start-of-Term Enrollment Audit. ${dto.coordinator_notes || ''}`.trim(),
          },
        });

        // 2. Update TermEnrollment
        const updatedEnrollment = await tx.termEnrollment.update({
          where: { enrollment_id: enrollmentId },
          data: {
            status: 'APPROVED',
            reviewed_by_employee_id: coordinator.employee_id,
            reviewed_at: new Date(),
            coordinator_notes: dto.coordinator_notes,
            disbursement_id: disbursement.disbursement_id,
            enrolled_subjects: (dto.adjusted_subjects ?? enrollment.enrolled_subjects) as any,
          },
        });

        // 3. Transition enrolled subjects to ENROLLED in scholar's prospectus
        const enrolledSubs = (dto.adjusted_subjects ?? enrollment.enrolled_subjects) as any[];
        if (Array.isArray(enrolledSubs) && enrollment.scholar_profile.prospectus) {
          const prospectusId = enrollment.scholar_profile.prospectus.prospectus_id;
          for (const sub of enrolledSubs) {
            const normCode = this.enrollmentOcrService.normalizeSubjectCode(sub.subject_code);
            const matchingSubject = enrollment.scholar_profile.prospectus.subjects.find(
              (ps) => this.enrollmentOcrService.normalizeSubjectCode(ps.subject_code) === normCode,
            );

            if (matchingSubject && matchingSubject.status === 'UNTAKEN') {
              await tx.prospectusSubject.update({
                where: { subject_id: matchingSubject.subject_id },
                data: {
                  status: 'ENROLLED',
                  remarks: `Enrolled in ${enrollment.academic_year} ${enrollment.semester}`,
                },
              });
            }
          }
        }

        // 4. Update COR & SOA documents status to VERIFIED in ScholarDocument table
        if (enrollment.cor_document_id) {
          await tx.scholarDocument.update({
            where: { document_id: enrollment.cor_document_id },
            data: {
              status: 'VERIFIED',
              verified_at: new Date(),
              reviewed_by_employee_id: coordinator.employee_id,
            },
          });
        }
        if (enrollment.soa_document_id && enrollment.soa_document_id !== enrollment.cor_document_id) {
          await tx.scholarDocument.update({
            where: { document_id: enrollment.soa_document_id },
            data: {
              status: 'VERIFIED',
              verified_at: new Date(),
              reviewed_by_employee_id: coordinator.employee_id,
            },
          });
        }

        return { updatedEnrollment, disbursement };
      });

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

      this.eventsGateway.emitToUser(enrollment.scholar_profile.user_id, 'enrollment:approved', {
        enrollment_id: enrollmentId,
        scholar_id: enrollment.scholar_profile_id,
        disbursement_id: result.disbursement.disbursement_id,
      });
      this.eventsGateway.emitToStaff('enrollment:approved', {
        enrollment_id: enrollmentId,
        scholar_id: enrollment.scholar_profile_id,
        disbursement_id: result.disbursement.disbursement_id,
      });

      return {
        message: 'Term enrollment approved and endorsed to Grantor disbursement queue.',
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

      await this.auditService.log(
        userId,
        'REQUEST_CHANGES_TERM_ENROLLMENT',
        `Requested changes for enrollment #${enrollmentId}: ${dto.coordinator_notes || 'No notes'}`,
      );

      this.eventsGateway.emitToUser(enrollment.scholar_profile.user_id, 'enrollment:changes_requested', {
        enrollment_id: enrollmentId,
        scholar_id: enrollment.scholar_profile_id,
        notes: dto.coordinator_notes,
      });
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

      await this.auditService.log(
        userId,
        'REJECT_TERM_ENROLLMENT',
        `Rejected enrollment #${enrollmentId}: ${dto.coordinator_notes || 'No notes'}`,
      );

      this.eventsGateway.emitToUser(enrollment.scholar_profile.user_id, 'enrollment:rejected', {
        enrollment_id: enrollmentId,
        scholar_id: enrollment.scholar_profile_id,
        notes: dto.coordinator_notes,
      });
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
      throw new NotFoundException(`Term enrollment #${enrollmentId} not found.`);
    }

    if (!enrollment.disbursement_id || !enrollment.disbursement) {
      throw new BadRequestException('No pending disbursement found for this enrollment.');
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
    this.eventsGateway.emitToUser(enrollment.scholar_profile.user_id, 'disbursement:updated', {
      disbursement_id: updatedDisbursement.disbursement_id,
      status: 'RELEASED',
      amount: updatedDisbursement.amount,
    });

    return {
      message: 'Disbursement authorized and marked as released.',
      disbursement: updatedDisbursement,
    };
  }
}
