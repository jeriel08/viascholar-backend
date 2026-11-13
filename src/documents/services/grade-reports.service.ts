import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { QueryGradeReportsDto } from '../dto/query-grade-reports.dto.js';
import { UpdateGradeReportStatusDto } from '../dto/update-grade-report-status.dto.js';
import { Prisma } from '../../generated/prisma/client.js';

@Injectable()
export class GradeReportsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
  ) {}

  // Scholar views all their semestral grade reports (Grade Monitoring)
  async getMyGradeReports(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const reports = await this.prisma.gradeReport.findMany({
      where: { scholar_profile_id: scholar.profile_id },
      orderBy: { submitted_at: 'desc' },
      include: {
        grade_items: true,
        document: {
          select: {
            document_id: true,
            document_type: true,
            file_name: true,
            file_url: true,
            status: true,
          },
        },
        reviewed_by_employee: {
          select: {
            employee_id: true,
            first_name: true,
            last_name: true,
            title: true,
          },
        },
        scholar_profile: {
          include: {
            school_grading_system: true,
          },
        },
      },
    });

    if (reports.length > 0) {
      const latestReport = reports[0];
      const priorResolvedAppeal = reports.some(
        (gr) =>
          gr.report_id !== latestReport.report_id &&
          (gr.appeal_status === 'APPROVED' || gr.appeal_status === 'DENIED'),
      );

      if (
        latestReport.status === 'FLAGGED' &&
        (latestReport.appeal_status === 'NONE' || !latestReport.appeal_status) &&
        priorResolvedAppeal
      ) {
        const archivedAt = (scholar as any).archived_at ?? new Date();
        const archiveReason =
          (scholar as any).archive_reason ?? 'FAILED_SECOND_CHANCE';
        const archiveNotes =
          (scholar as any).archive_notes ??
          `Failed 2nd-chance probation during ${latestReport.academic_year} (${latestReport.semester}) with GWA ${Number(latestReport.gpa).toFixed(2)}.`;
        const decisionNotes =
          'Second Chance probation exhausted. Automatic archival triggered due to subsequent academic retention deficiency.';

        if (typeof (this.prisma as any).gradeReport?.update === 'function') {
          await (this.prisma as any).gradeReport.update({
            where: { report_id: latestReport.report_id },
            data: {
              appeal_status: 'DENIED',
              appeal_reviewed_at: archivedAt,
              appeal_decision_notes: decisionNotes,
            },
          });
        }
        if (typeof (this.prisma as any).scholarProfile?.update === 'function') {
          await (this.prisma as any).scholarProfile.update({
            where: { profile_id: scholar.profile_id },
            data: {
              academic_baseline_status: 'DISCONTINUED',
              archived_at: archivedAt,
              archive_reason: archiveReason,
              archive_notes: archiveNotes,
            },
          });
        }
        if (typeof (this.prisma as any).contract?.updateMany === 'function') {
          await (this.prisma as any).contract.updateMany({
            where: {
              scholar_profile_id: scholar.profile_id,
              status: { in: ['SIGNED', 'PENDING'] },
            },
            data: { status: 'TERMINATED' },
          });
        }
        if (
          typeof (this.prisma as any).disbursement?.updateMany === 'function'
        ) {
          await (this.prisma as any).disbursement.updateMany({
            where: {
              scholar_profile_id: scholar.profile_id,
              status: { in: ['PENDING', 'AUTHORIZED'] },
            },
            data: {
              status: 'CANCELLED',
              remarks: `Scholarship archived: Failed 2nd-chance probation for ${latestReport.academic_year} ${latestReport.semester}.`,
            },
          });
        }

        latestReport.appeal_status = 'DENIED';
        latestReport.appeal_decision_notes = decisionNotes;
        if (latestReport.scholar_profile) {
          (latestReport.scholar_profile as any).academic_baseline_status =
            'DISCONTINUED';
          (latestReport.scholar_profile as any).archived_at = archivedAt;
          (latestReport.scholar_profile as any).archive_reason = archiveReason;
          (latestReport.scholar_profile as any).archive_notes = archiveNotes;
        }
      }
    }

    const [grantorUser, coordinatorUser] =
      typeof (this.prisma as any).user?.findFirst === 'function'
        ? await Promise.all([
            (this.prisma as any).user.findFirst({
              where: { role: 'GRANTOR', is_active: true },
              orderBy: { user_id: 'asc' },
              select: { email: true },
            }),
            (this.prisma as any).user.findFirst({
              where: { role: 'COORDINATOR', is_active: true },
              orderBy: { user_id: 'asc' },
              select: { email: true },
            }),
          ])
        : [null, null];

    const grantorEmail = grantorUser?.email || 'grantor@viascholar.com';
    const coordinatorEmail =
      coordinatorUser?.email || 'coordinator@viascholar.com';

    return reports.map((r) => ({
      ...r,
      grantor_email: grantorEmail,
      coordinator_email: coordinatorEmail,
    }));
  }

  // Staff views all semestral grade reports across scholars
  async getAllGradeReports(query: QueryGradeReportsDto) {
    const where: Prisma.GradeReportWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.academic_year) {
      where.academic_year = query.academic_year;
    }

    if (query.semester) {
      where.semester = query.semester;
    }

    if (query.search) {
      where.scholar_profile = {
        is: {
          OR: [
            { first_name: { contains: query.search, mode: 'insensitive' } },
            { last_name: { contains: query.search, mode: 'insensitive' } },
            { student_number: { contains: query.search, mode: 'insensitive' } },
          ],
        },
      };
    }

    return this.prisma.gradeReport.findMany({
      where,
      orderBy: { submitted_at: 'desc' },
      include: {
        scholar_profile: {
          include: {
            user: { select: { user_id: true, email: true, role: true } },
          },
        },
        grade_items: true,
        document: {
          select: {
            document_id: true,
            document_type: true,
            file_name: true,
            file_url: true,
          },
        },
        reviewed_by_employee: {
          select: {
            employee_id: true,
            first_name: true,
            last_name: true,
            title: true,
          },
        },
      },
    });
  }

  // Staff updates or overrides a grade report review status
  async updateGradeReportStatus(
    coordinatorUserId: number,
    reportId: number,
    dto: UpdateGradeReportStatusDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: coordinatorUserId },
    });

    if (!employee) {
      throw new NotFoundException(
        'Employee profile not found for current user.',
      );
    }

    const report = await this.prisma.gradeReport.findUnique({
      where: { report_id: reportId },
      include: {
        scholar_profile: {
          include: { user: true },
        },
      },
    });

    if (!report) {
      throw new NotFoundException(`Grade report ID ${reportId} not found.`);
    }

    const isEligible = dto.status === 'APPROVED';

    const updated = await this.prisma.gradeReport.update({
      where: { report_id: reportId },
      data: {
        status: dto.status,
        is_eligible: isEligible,
        remarks: dto.remarks ?? report.remarks,
        reviewed_at: new Date(),
        reviewed_by_employee_id: employee.employee_id,
      },
      include: {
        grade_items: true,
        scholar_profile: true,
        reviewed_by_employee: true,
      },
    });

    await this.auditService.log(
      coordinatorUserId,
      'GRADE_REPORT_STATUS_UPDATED',
      `Staff updated Grade Report ID ${reportId} status to ${dto.status}${dto.remarks ? `: ${dto.remarks}` : ''}`,
    );

    // Send email notification to scholar
    const studentEmail = report.scholar_profile?.user?.email;
    const studentName =
      `${report.scholar_profile?.first_name} ${report.scholar_profile?.last_name}`.trim() ||
      'Scholar';

    if (studentEmail) {
      void this.mailService.sendGradeReportStatusUpdated(studentEmail, {
        studentName,
        academicYear: report.academic_year,
        semester: report.semester,
        status: dto.status,
        remarks: dto.remarks,
      });
    }

    return updated;
  }
}
