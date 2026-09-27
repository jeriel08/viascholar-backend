import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { SubmitAppealDto } from '../dto/submit-appeal.dto.js';
import { ReviewAppealDto } from '../dto/review-appeal.dto.js';

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
  async submitAppeal(userId: number, reportId: number, dto: SubmitAppealDto) {
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
      throw new ForbiddenException(
        'You cannot appeal a grade report that is not yours.',
      );
    }

    if (report.appeal_status === 'PENDING_GRANTOR') {
      throw new BadRequestException(
        'An academic appeal is already under review for this term.',
      );
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

        const appealMetadata = {
          report_id: report.report_id,
          scholar_profile_id: scholar.profile_id,
          student_name: `${scholar.first_name} ${scholar.last_name}`.trim(),
          student_number: scholar.student_number || 'ID Pending',
          academic_year: report.academic_year,
          semester: report.semester,
          gpa: Number(report.gpa),
          evaluation_flag: report.evaluation_flag || 'FLAGGED',
          appeal_notes: dto.appeal_notes,
          appeal_submitted_at: updatedReport.appeal_submitted_at?.toISOString(),
        };

        const appealMsgText = `Academic Second Chance Appeal submitted for ${report.academic_year} ${report.semester}.\n\nScholar Statement:\n"${dto.appeal_notes}"`;

        const newMsg = await this.prisma.message.create({
          data: {
            conversation_id: convo.conversation_id,
            sender_user_id: userId,
            message_text: appealMsgText,
            message_type: 'SYSTEM_APPEAL_SUBMITTED',
            metadata: appealMetadata as any,
          },
        });

        await this.prisma.conversation.update({
          where: { conversation_id: convo.conversation_id },
          data: {
            last_message_at: new Date(),
            last_message_preview: `📢 Academic Appeal: ${dto.appeal_notes.slice(0, 80)}...`,
          },
        });

        const chatPayload = {
          message_id: newMsg.message_id,
          conversation_id: convo.conversation_id,
          sender_user_id: userId,
          sender_name: `${scholar.first_name} ${scholar.last_name}`.trim(),
          sender_role: 'SCHOLAR',
          message_text: appealMsgText,
          message_type: 'SYSTEM_APPEAL_SUBMITTED',
          metadata: appealMetadata,
          is_read: false,
          sent_at: newMsg.sent_at,
        };

        this.eventsGateway.emitToRoom(
          `conversation_${convo.conversation_id}`,
          'chat:new_message',
          chatPayload,
        );
        this.eventsGateway.emitToUser(
          grantor.user_id,
          'chat:new_message',
          chatPayload,
        );
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

    // If appeal is APPROVED: put scholar on active probation
    if (isApproved) {
      await this.prisma.scholarProfile.update({
        where: { profile_id: report.scholar_profile_id },
        data: {
          academic_baseline_status: 'ON_PROBATION',
        },
      });
    }

    // If appeal is DENIED: terminate contract, update profile standing, and cancel pending disbursements
    if (!isApproved) {
      await this.prisma.contract.updateMany({
        where: {
          scholar_profile_id: report.scholar_profile_id,
          status: { in: ['SIGNED', 'PENDING'] },
        },
        data: {
          status: 'TERMINATED',
        },
      });

      await this.prisma.scholarProfile.update({
        where: { profile_id: report.scholar_profile_id },
        data: {
          academic_baseline_status: 'DISCONTINUED',
        },
      });

      await this.prisma.disbursement.updateMany({
        where: {
          scholar_profile_id: report.scholar_profile_id,
          status: { in: ['PENDING', 'AUTHORIZED'] },
        },
        data: {
          status: 'CANCELLED',
          remarks: `Scholarship discontinued: Academic appeal denied for ${report.academic_year} ${report.semester}.`,
        },
      });
    }

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
        const verdictMetadata = {
          report_id: report.report_id,
          scholar_profile_id: report.scholar_profile_id,
          student_name:
            `${report.scholar_profile.first_name} ${report.scholar_profile.last_name}`.trim(),
          academic_year: report.academic_year,
          semester: report.semester,
          decision: dto.decision,
          decision_notes: dto.decision_notes || '',
          reviewed_by_name:
            `${employee.first_name} ${employee.last_name}`.trim(),
          reviewed_at: updated.appeal_reviewed_at?.toISOString(),
        };

        const decisionText = isApproved
          ? `Second Chance Appeal Approved for ${report.academic_year} ${report.semester}.\n\nGrantor Notes:\n"${dto.decision_notes || 'Maintain passing grades to clear probation.'}"`
          : `Second Chance Appeal Denied for ${report.academic_year} ${report.semester}.\n\nGrantor Remarks:\n"${dto.decision_notes || 'Scholarship retention criteria not met.'}"`;

        const verdictMsg = await this.prisma.message.create({
          data: {
            conversation_id: convo.conversation_id,
            sender_user_id: grantorUserId,
            message_text: decisionText,
            message_type: isApproved
              ? 'SYSTEM_APPEAL_APPROVED'
              : 'SYSTEM_APPEAL_DENIED',
            metadata: verdictMetadata as any,
          },
        });

        await this.prisma.conversation.update({
          where: { conversation_id: convo.conversation_id },
          data: {
            last_message_at: new Date(),
            last_message_preview: isApproved
              ? `✅ Appeal Approved (${report.academic_year} ${report.semester})`
              : `❌ Appeal Denied (${report.academic_year} ${report.semester})`,
          },
        });

        const chatPayload = {
          message_id: verdictMsg.message_id,
          conversation_id: convo.conversation_id,
          sender_user_id: grantorUserId,
          sender_name: `${employee.first_name} ${employee.last_name}`.trim(),
          sender_role: 'GRANTOR',
          message_text: decisionText,
          message_type: isApproved
            ? 'SYSTEM_APPEAL_APPROVED'
            : 'SYSTEM_APPEAL_DENIED',
          metadata: verdictMetadata,
          is_read: false,
          sent_at: verdictMsg.sent_at,
        };

        this.eventsGateway.emitToRoom(
          `conversation_${convo.conversation_id}`,
          'chat:new_message',
          chatPayload,
        );
        this.eventsGateway.emitToUser(
          report.scholar_profile.user_id,
          'chat:new_message',
          chatPayload,
        );
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
    const studentName =
      `${report.scholar_profile.first_name} ${report.scholar_profile.last_name}`.trim();
    if (studentEmail) {
      void this.mailService.sendGradeReportStatusUpdated(studentEmail, {
        studentName,
        academicYear: report.academic_year,
        semester: report.semester,
        status: isApproved ? 'APPROVED' : 'FLAGGED',
        remarks:
          `Appeal Verdict: ${dto.decision}. ${dto.decision_notes || ''}`.trim(),
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
    this.eventsGateway.emitToUser(
      report.scholar_profile.user_id,
      'grade_report:appeal_decided',
      payload,
    );

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
