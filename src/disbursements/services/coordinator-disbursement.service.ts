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
  RecordCheckIssuanceDto,
  SettleOfficialReceiptDto,
} from '../dto/disbursement.dto.js';

@Injectable()
export class CoordinatorDisbursementService {
  private readonly logger = new Logger(CoordinatorDisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
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

  // 1. Get filtered queue of disbursements for management and auditing
  async getDisbursementsQueue(filters?: {
    status?: string;
    school?: string;
    search?: string;
    academicYear?: string;
    semester?: string;
  }) {
    const where: any = {};

    if (filters?.status && filters.status !== 'ALL') {
      where.status = filters.status;
    }

    if (filters?.academicYear) where.academic_year = filters.academicYear;
    if (filters?.semester) where.semester = filters.semester;

    if (filters?.school) {
      where.scholar_profile = {
        school_name: { contains: filters.school, mode: 'insensitive' },
      };
    }

    if (filters?.search) {
      const search = filters.search.trim();
      where.OR = [
        { check_number: { contains: search, mode: 'insensitive' } },
        { voucher_number: { contains: search, mode: 'insensitive' } },
        { or_number: { contains: search, mode: 'insensitive' } },
        { scholar_profile: { first_name: { contains: search, mode: 'insensitive' } } },
        { scholar_profile: { last_name: { contains: search, mode: 'insensitive' } } },
        { scholar_profile: { student_number: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const items = await this.prisma.disbursement.findMany({
      where,
      orderBy: { updated_at: 'desc' },
      include: {
        scholar_profile: {
          include: {
            school_grading_system: true,
          },
        },
        term_enrollment: {
          include: {
            cor_document: true,
            soa_document: true,
          },
        },
        or_document: true,
        approved_by_employee: {
          select: { employee_id: true, first_name: true, last_name: true, title: true },
        },
        settled_by_employee: {
          select: { employee_id: true, first_name: true, last_name: true, title: true },
        },
      },
    });

    return items;
  }

  // 2. Record physical check issuance with Payee locked to registered institutional entity
  async recordCheckIssuance(userId: number, disbursementId: number, dto: RecordCheckIssuanceDto) {
    const coordinator = await this.getCoordinatorEmployee(userId);

    const disbursement = await this.prisma.disbursement.findUnique({
      where: { disbursement_id: disbursementId },
      include: {
        scholar_profile: {
          include: { school_grading_system: true },
        },
      },
    });

    if (!disbursement) {
      throw new NotFoundException(`Disbursement #${disbursementId} not found.`);
    }

    if (disbursement.status !== 'AUTHORIZED' && disbursement.status !== 'RELEASED' && disbursement.status !== 'PENDING') {
      throw new BadRequestException(`Cannot issue check for disbursement with status "${disbursement.status}".`);
    }

    // Payee is locked strictly to the registered institutional school entity
    const lockedSchoolPayee = disbursement.scholar_profile?.school_name || 'Registered University Cashier';

    const updated = await this.prisma.disbursement.update({
      where: { disbursement_id: disbursementId },
      data: {
        status: 'CHECK_ISSUED',
        check_payee: lockedSchoolPayee,
        check_number: dto.check_number.trim(),
        bank_name: dto.bank_name.trim(),
        voucher_number: dto.voucher_number ? dto.voucher_number.trim() : disbursement.voucher_number,
        date_issued: new Date(dto.date_issued),
        payment_method: dto.payment_method || 'DIRECT_TO_SCHOOL_CHECK',
        remarks: dto.remarks
          ? `${disbursement.remarks || ''}\nCheck Issued [${dto.check_number}]: ${dto.remarks}`.trim()
          : disbursement.remarks,
      },
      include: {
        scholar_profile: true,
      },
    });

    await this.auditService.log(
      userId,
      'RECORD_CHECK_ISSUANCE',
      `Coordinator ${coordinator.first_name} recorded crossed check #${dto.check_number} (${dto.bank_name}) for PHP ${disbursement.amount} payable to ${lockedSchoolPayee}`,
    );

    // Notify staff & scholar in real time
    this.eventsGateway.emitToStaff('disbursement:updated', {
      disbursement_id: updated.disbursement_id,
      status: 'CHECK_ISSUED',
      check_number: updated.check_number,
      bank_name: updated.bank_name,
    });

    this.eventsGateway.emitToUser(updated.scholar_profile.user_id, 'disbursement:updated', {
      disbursement_id: updated.disbursement_id,
      status: 'CHECK_ISSUED',
      check_number: updated.check_number,
      bank_name: updated.bank_name,
      check_payee: updated.check_payee,
      amount: updated.amount,
      message: `Your crossed tuition check (#${updated.check_number}) is ready. Please claim it and hand it over to the university cashier to receive your Official Receipt.`,
    });

    return {
      message: 'Check issuance details successfully recorded.',
      disbursement: updated,
    };
  }

  // 3. Coordinator audits uploaded Official Receipt and marks transaction as SETTLED
  async settleOfficialReceipt(userId: number, disbursementId: number, dto: SettleOfficialReceiptDto) {
    const coordinator = await this.getCoordinatorEmployee(userId);

    const disbursement = await this.prisma.disbursement.findUnique({
      where: { disbursement_id: disbursementId },
      include: {
        scholar_profile: true,
        or_document: true,
      },
    });

    if (!disbursement) {
      throw new NotFoundException(`Disbursement #${disbursementId} not found.`);
    }

    if (disbursement.status !== 'OR_SUBMITTED' && disbursement.status !== 'CHECK_ISSUED') {
      throw new BadRequestException(`Cannot settle disbursement with status "${disbursement.status}".`);
    }

    if (dto.approved) {
      const updated = await this.prisma.$transaction(async (tx) => {
        // 1. Mark OR Document as VERIFIED
        if (disbursement.or_document_id) {
          await tx.scholarDocument.update({
            where: { document_id: disbursement.or_document_id },
            data: {
              status: 'VERIFIED',
              verified_at: new Date(),
              reviewed_by_employee_id: coordinator.employee_id,
            },
          });
        }

        // 2. Mark Disbursement as SETTLED
        return tx.disbursement.update({
          where: { disbursement_id: disbursementId },
          data: {
            status: 'SETTLED',
            or_verified_at: new Date(),
            settled_at: new Date(),
            settled_by_employee_id: coordinator.employee_id,
            date_claimed: disbursement.date_claimed || new Date(),
            remarks: dto.remarks
              ? `${disbursement.remarks || ''}\nSettlement: ${dto.remarks}`.trim()
              : disbursement.remarks,
          },
          include: {
            scholar_profile: true,
            or_document: true,
          },
        });
      });

      await this.auditService.log(
        userId,
        'SETTLE_DISBURSEMENT_OR',
        `Coordinator verified Official Receipt #${updated.or_number || ''} and marked disbursement #${disbursementId} as SETTLED for PHP ${updated.amount}`,
      );

      this.eventsGateway.emitToStaff('disbursement:updated', {
        disbursement_id: updated.disbursement_id,
        status: 'SETTLED',
      });

      this.eventsGateway.emitToUser(updated.scholar_profile.user_id, 'disbursement:updated', {
        disbursement_id: updated.disbursement_id,
        status: 'SETTLED',
        message: 'Your university Official Receipt has been verified. Tuition disbursement is fully settled!',
      });

      return {
        message: 'Disbursement successfully settled and verified.',
        disbursement: updated,
      };
    } else {
      // Reject OR photo and request re-upload
      const updated = await this.prisma.$transaction(async (tx) => {
        if (disbursement.or_document_id) {
          await tx.scholarDocument.update({
            where: { document_id: disbursement.or_document_id },
            data: {
              status: 'NEEDS_REUPLOAD',
              rejection_reason: dto.rejection_reason || 'Official Receipt photo is unclear or amount does not match.',
              reviewed_by_employee_id: coordinator.employee_id,
            },
          });
        }

        return tx.disbursement.update({
          where: { disbursement_id: disbursementId },
          data: {
            status: 'CHECK_ISSUED',
            remarks: `${disbursement.remarks || ''}\nOR Rejected: ${dto.rejection_reason || 'Please re-upload receipt photo.'}`.trim(),
          },
          include: { scholar_profile: true },
        });
      });

      this.eventsGateway.emitToUser(updated.scholar_profile.user_id, 'disbursement:updated', {
        disbursement_id: updated.disbursement_id,
        status: 'CHECK_ISSUED',
        message: `Official Receipt rejected: ${dto.rejection_reason || 'Please re-upload a clear photo.'}`,
      });

      return {
        message: 'Official Receipt marked for re-upload.',
        disbursement: updated,
      };
    }
  }
}
