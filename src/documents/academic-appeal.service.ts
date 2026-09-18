import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { SubmitAppealDto } from './dto/submit-appeal.dto.js';
import { ReviewAppealDto } from './dto/review-appeal.dto.js';

@Injectable()
export class AcademicAppealService {
  private readonly logger = new Logger(AcademicAppealService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // 1. Scholar submits a Second Chance Academic Appeal for a flagged Grade Report
  async submitAppeal(
    userId: number,
    reportId: number,
    dto: SubmitAppealDto,
  ) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { user: true },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const report = await this.prisma.gradeReport.findUnique({
      where: { report_id: reportId },
      include: {
        document: true,
        grade_items: true,
      },
    });

    if (!report) {
      throw new NotFoundException(`Grade report ID ${reportId} not found.`);
    }

    if (report.scholar_profile_id !== scholar.profile_id) {
      throw new ForbiddenException('You cannot appeal a grade report that is not yours.');
    }

    if (report.appeal_status === 'PENDING_GRANTOR') {
      throw new BadRequestException('An academic appeal is already under review for this term.');
    }

    // Update GradeReport with appeal details
    const updatedReport = await this.prisma.gradeReport.update({
      where: { report_id: reportId },
      data: {
        appeal_status: 'PENDING_GRANTOR',
        appeal_notes: dto.appeal_notes,
        appeal_document_id: dto.appeal_document_id,
        appeal_submitted_at: new Date(),
      },
      include: {
        scholar_profile: {
          include: { user: true, school_grading_system: true },
        },
        grade_items: true,
        document: true,
        appeal_document: true,
      },
    });

    // Notify all active Grantors via direct conversation / message
    try {
      const grantorUsers = await this.prisma.user.findMany({
        where: { role: 'GRANTOR', is_active: true },
      });

      for (const grantor of grantorUsers) {
        let convo = await this.prisma.conversation.findUnique({
          where: {
            scholar_user_id_coordinator_user_id: {
              scholar_user_id: userId,
              coordinator_user_id: grantor.user_id,
            },
          },
        });

        if (!convo) {
          convo = await this.prisma.conversation.create({
            data: {
              scholar_user_id: userId,
              coordinator_user_id: grantor.user_id,
              subject: `Academic Second Chance Appeal - ${report.academic_year} ${report.semester}`,
              status: 'ACTIVE',
            },
          });
        }

        const appealMsgText = `📢 [ACADEMIC SECOND CHANCE APPEAL SUBMITTED]\n\n` +
          `Scholar: ${scholar.first_name} ${scholar.last_name} (${scholar.student_number || 'ID Pending'})\n` +
          `Term: ${report.academic_year} • ${report.semester}\n` +
          `Term GWA: ${Number(report.gpa).toFixed(2)} (Retention Status: ${report.evaluation_flag || 'FLAGGED'})\n\n` +
          `Scholar Statement:\n"${dto.appeal_notes}"\n\n` +
          `Please review the full academic record and issue your official verdict.`;

        await this.prisma.message.create({
          data: {
            conversation_id: convo.conversation_id,
            sender_user_id: userId,
            message_text: appealMsgText,
          },
        });

        await this.prisma.conversation.update({
          where: { conversation_id: convo.conversation_id },
          data: {
            last_message_at: new Date(),
            last_message_preview: `Academic Appeal: ${dto.appeal_notes.slice(0, 80)}...`,
          },
        });
      }
    } catch (msgErr) {
      this.logger.warn(`Failed to post appeal chat notification: ${msgErr}`);
    }

    await this.auditService.log(
      userId,
      'ACADEMIC_APPEAL_SUBMITTED',
      `Scholar submitted second chance appeal for Grade Report #${reportId} (${report.academic_year} ${report.semester}).`,
    );

    // Emit real-time event to staff
    const appealPayload = {
      reportId: updatedReport.report_id,
      scholarProfileId: updatedReport.scholar_profile_id,
      studentName: `${scholar.first_name} ${scholar.last_name}`.trim(),
      academicYear: updatedReport.academic_year,
      semester: updatedReport.semester,
      gpa: Number(updatedReport.gpa),
      appealNotes: dto.appeal_notes,
      appealSubmittedAt: updatedReport.appeal_submitted_at?.toISOString(),
    };

    this.eventsGateway.emitToStaff('grade_report:appealed', appealPayload);

    return updatedReport;
  }

  // 2. Grantor issues verdict on scholar second chance appeal
  async reviewAppeal(
    grantorUserId: number,
    reportId: number,
    dto: ReviewAppealDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: grantorUserId },
      include: { user: true },
    });

    if (!employee) {
      throw new NotFoundException('Employee profile not found.');
    }

    const report = await this.prisma.gradeReport.findUnique({
      where: { report_id: reportId },
      include: {
        scholar_profile: {
          include: { user: true, prospectus: { include: { subjects: true } } },
        },
        grade_items: true,
      },
    });

    if (!report) {
      throw new NotFoundException(`Grade report ID ${reportId} not found.`);
    }

    if (report.appeal_status !== 'PENDING_GRANTOR') {
      throw new BadRequestException(
        `Grade report ID ${reportId} is not currently awaiting an appeal decision (status: ${report.appeal_status}).`,
      );
    }

    const isApproved = dto.decision === 'APPROVED';

    const updated = await this.prisma.gradeReport.update({
      where: { report_id: reportId },
      data: {
        appeal_status: isApproved ? 'APPROVED' : 'DENIED',
        appeal_reviewed_at: new Date(),
        appeal_reviewed_by_employee_id: employee.employee_id,
        appeal_decision_notes: dto.decision_notes,
        is_eligible: isApproved,
        status: isApproved ? 'APPROVED' : 'FLAGGED',
      },
      include: {
        scholar_profile: { include: { user: true } },
        grade_items: true,
        appeal_reviewed_by: true,
      },
    });

    // Post verdict message in conversation
    try {
      const convo = await this.prisma.conversation.findUnique({
        where: {
          scholar_user_id_coordinator_user_id: {
            scholar_user_id: report.scholar_profile.user_id,
            coordinator_user_id: grantorUserId,
          },
        },
      });

      if (convo) {
        const decisionText = isApproved
          ? `✅ [SECOND CHANCE APPEAL APPROVED]\n\nYour academic appeal for ${report.academic_year} ${report.semester} has been APPROVED on probationary standing. You may now proceed to enroll for the upcoming term.\n\nGrantor Notes:\n${dto.decision_notes || 'Maintain passing grades to clear probation.'}`
          : `❌ [SECOND CHANCE APPEAL DENIED]\n\nYour academic appeal for ${report.academic_year} ${report.semester} was reviewed and DENIED.\n\nGrantor Remarks:\n${dto.decision_notes || 'Scholarship retention criteria not met.'}`;

        await this.prisma.message.create({
          data: {
            conversation_id: convo.conversation_id,
            sender_user_id: grantorUserId,
            message_text: decisionText,
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to post verdict message: ${err}`);
    }

    await this.auditService.log(
      grantorUserId,
      'ACADEMIC_APPEAL_DECIDED',
      `Grantor ${employee.first_name} ${employee.last_name} ${dto.decision} appeal for Grade Report #${reportId}. Notes: ${dto.decision_notes || 'N/A'}`,
    );

    // Send email notification
    const studentEmail = report.scholar_profile.user?.email;
    const studentName = `${report.scholar_profile.first_name} ${report.scholar_profile.last_name}`.trim();
    if (studentEmail) {
      void this.mailService.sendGradeReportStatusUpdated(studentEmail, {
        studentName,
        academicYear: report.academic_year,
        semester: report.semester,
        status: isApproved ? 'APPROVED' : 'FLAGGED',
        remarks: `Appeal Verdict: ${dto.decision}. ${dto.decision_notes || ''}`.trim(),
      });
    }

    const payload = {
      reportId: updated.report_id,
      scholarProfileId: updated.scholar_profile_id,
      decision: dto.decision,
      decisionNotes: dto.decision_notes,
      reviewedAt: updated.appeal_reviewed_at?.toISOString(),
    };

    this.eventsGateway.emitToStaff('grade_report:appeal_decided', payload);
    this.eventsGateway.emitToUser(report.scholar_profile.user_id, 'grade_report:appeal_decided', payload);

    return updated;
  }

  // 3. List all pending academic appeals for Grantor dashboard
  async getPendingAppeals() {
    return this.prisma.gradeReport.findMany({
      where: { appeal_status: 'PENDING_GRANTOR' },
      orderBy: { appeal_submitted_at: 'desc' },
      include: {
        scholar_profile: {
          include: {
            school_grading_system: true,
            user: { select: { user_id: true, email: true } },
          },
        },
        grade_items: true,
        document: true,
        appeal_document: true,
      },
    });
  }
}
