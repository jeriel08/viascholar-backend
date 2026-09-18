import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { AuthorizeDisbursementBatchDto } from '../dto/disbursement.dto.js';

@Injectable()
export class GrantorDisbursementService {
  private readonly logger = new Logger(GrantorDisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  private async getGrantorEmployee(userId: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: userId },
    });
    if (!employee) {
      throw new NotFoundException('Grantor employee record not found.');
    }
    return employee;
  }

  // 1. Consolidated billing report of coordinator-approved SOAs grouped by university
  async getConsolidatedBillingReport(academicYear?: string, semester?: string) {
    const where: any = {
      status: { in: ['PENDING', 'AUTHORIZED', 'RELEASED', 'CHECK_ISSUED', 'OR_SUBMITTED', 'SETTLED'] },
    };
    if (academicYear) where.academic_year = academicYear;
    if (semester) where.semester = semester;

    const disbursements = await this.prisma.disbursement.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        scholar_profile: {
          include: {
            school_grading_system: true,
          },
        },
        term_enrollment: {
          include: {
            soa_document: true,
            cor_document: true,
          },
        },
        or_document: true,
        approved_by_employee: {
          select: { employee_id: true, first_name: true, last_name: true, title: true },
        },
      },
    });

    // Group by school name
    const grouped = new Map<string, {
      school_name: string;
      total_amount: number;
      pending_amount: number;
      authorized_amount: number;
      settled_amount: number;
      total_scholars: number;
      pending_count: number;
      disbursements: typeof disbursements;
    }>();

    for (const d of disbursements) {
      const schoolName = d.scholar_profile?.school_name || 'Unassigned University';
      if (!grouped.has(schoolName)) {
        grouped.set(schoolName, {
          school_name: schoolName,
          total_amount: 0,
          pending_amount: 0,
          authorized_amount: 0,
          settled_amount: 0,
          total_scholars: 0,
          pending_count: 0,
          disbursements: [],
        });
      }

      const group = grouped.get(schoolName)!;
      const amount = Number(d.amount);
      group.total_amount += amount;
      group.total_scholars += 1;
      group.disbursements.push(d);

      if (d.status === 'PENDING') {
        group.pending_amount += amount;
        group.pending_count += 1;
      } else if (d.status === 'AUTHORIZED' || d.status === 'RELEASED') {
        group.authorized_amount += amount;
      } else if (d.status === 'SETTLED') {
        group.settled_amount += amount;
      }
    }

    return Array.from(grouped.values());
  }

  // 2. Authorize batch of disbursements and generate Disbursement Voucher (DV-YYYY-XXXX)
  async authorizeBatch(userId: number, dto: AuthorizeDisbursementBatchDto) {
    if (!dto.disbursement_ids || dto.disbursement_ids.length === 0) {
      throw new BadRequestException('No disbursements selected for authorization.');
    }

    const grantor = await this.getGrantorEmployee(userId);

    // Generate Voucher Number: DV-YYYY-XXXX
    const currentYear = new Date().getFullYear();
    const countVouchersThisYear = await this.prisma.disbursement.count({
      where: {
        voucher_number: { startsWith: `DV-${currentYear}` },
      },
    });
    const voucherNumber = `DV-${currentYear}-${String(countVouchersThisYear + 1).padStart(4, '0')}`;

    // Update selected disbursements in a transaction
    const updated = await this.prisma.$transaction(async (tx) => {
      // Find disbursements that are pending authorization
      const targetDisbursements = await tx.disbursement.findMany({
        where: {
          disbursement_id: { in: dto.disbursement_ids },
          status: 'PENDING',
        },
        include: { scholar_profile: true },
      });

      if (targetDisbursements.length === 0) {
        throw new BadRequestException('No pending disbursements found matching the provided IDs.');
      }

      const updatedRecords: any[] = [];
      for (const d of targetDisbursements) {
        const schoolPayee = d.scholar_profile?.school_name || 'University Cashier';
        const rec = await tx.disbursement.update({
          where: { disbursement_id: d.disbursement_id },
          data: {
            status: 'AUTHORIZED',
            voucher_number: voucherNumber,
            check_payee: schoolPayee,
            payment_method: 'DIRECT_TO_SCHOOL_CHECK',
            approved_by_employee_id: grantor.employee_id,
            remarks: dto.remarks
              ? `${d.remarks || ''}\nGrantor Voucher [${voucherNumber}]: ${dto.remarks}`.trim()
              : d.remarks,
          },
          include: { scholar_profile: true },
        });
        updatedRecords.push(rec);
      }

      return updatedRecords;
    });

    const totalBatchAmount = updated.reduce((sum, item) => sum + Number(item.amount), 0);

    await this.auditService.log(
      userId,
      'GRANTOR_AUTHORIZE_DISBURSEMENT_BATCH',
      `Grantor authorized ${updated.length} disbursements under Voucher ${voucherNumber} totaling PHP ${totalBatchAmount}`,
    );

    // Emit live socket updates
    this.eventsGateway.emitToStaff('disbursement:authorized', {
      voucher_number: voucherNumber,
      count: updated.length,
      total_amount: totalBatchAmount,
      disbursement_ids: updated.map((u) => u.disbursement_id),
    });

    for (const item of updated) {
      this.eventsGateway.emitToUser(item.scholar_profile.user_id, 'disbursement:updated', {
        disbursement_id: item.disbursement_id,
        status: 'AUTHORIZED',
        voucher_number: voucherNumber,
        amount: item.amount,
        message: `Tuition disbursement of PHP ${item.amount} authorized under Voucher ${voucherNumber}. Check is being prepared.`,
      });
    }

    return {
      message: `Successfully authorized ${updated.length} disbursements under Voucher ${voucherNumber}.`,
      voucher_number: voucherNumber,
      total_amount: totalBatchAmount,
      disbursements: updated,
    };
  }

  // 3. Get single voucher details with line items
  async getVoucherDetails(voucherNumber: string) {
    const items = await this.prisma.disbursement.findMany({
      where: { voucher_number: voucherNumber },
      include: {
        scholar_profile: true,
        approved_by_employee: true,
      },
    });

    if (items.length === 0) {
      throw new NotFoundException(`Disbursement Voucher ${voucherNumber} not found.`);
    }

    const totalAmount = items.reduce((sum, i) => sum + Number(i.amount), 0);
    const firstItem = items[0];

    return {
      voucher_number: voucherNumber,
      authorized_at: firstItem.updated_at,
      authorized_by: firstItem.approved_by_employee
        ? `${firstItem.approved_by_employee.first_name} ${firstItem.approved_by_employee.last_name}`
        : 'Grantor Office',
      payee_school: firstItem.check_payee || firstItem.scholar_profile?.school_name,
      total_amount: totalAmount,
      item_count: items.length,
      items,
    };
  }
}
