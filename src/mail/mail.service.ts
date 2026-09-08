import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildApplicationSubmittedStaffHtml,
  buildApplicationSubmittedStudentHtml,
  buildStageUpdatedHtml,
  buildApplicationApprovedHtml,
  buildApplicationRejectedHtml,
} from './templates/application.templates.js';
import {
  buildInterviewScheduledHtml,
  buildInterviewRescheduleRequestedStaffHtml,
  buildInterviewRescheduledHtml,
  buildInterviewCancelledHtml,
} from './templates/interview.templates.js';
import {
  buildContractReadyToSignHtml,
  buildContractSignedStudentHtml,
  buildContractSignedStaffHtml,
  buildContractChangeRequestToStaffHtml,
} from './templates/contract.templates.js';
import {
  buildDocumentActionRequiredHtml,
  buildGradeReportStatusUpdatedHtml,
} from './templates/document.templates.js';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private resend: Resend | null = null;
  private fromEmail: string;
  private frontendUrl: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.fromEmail =
      this.configService.get<string>('RESEND_FROM_EMAIL') ||
      'ViaScholar <onboarding@resend.dev>';
    this.frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log('Resend email service initialized successfully.');
    } else {
      this.logger.warn(
        'RESEND_API_KEY not configured. Outgoing emails will be logged to console in simulation mode.',
      );
    }
  }

  // Retrieve active staff (Admin, Grantor, Coordinator) emails
  async getStaffEmails(): Promise<string[]> {
    try {
      const staff = await this.prisma.user.findMany({
        where: {
          role: { in: ['ADMIN', 'GRANTOR', 'COORDINATOR'] },
          is_active: true,
        },
        select: { email: true },
      });
      return staff.map((u) => u.email).filter(Boolean);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch staff emails: ${msg}`);
      return [];
    }
  }

  // Core email dispatch method
  private async sendEmail(
    to: string | string[],
    subject: string,
    html: string,
  ): Promise<void> {
    const recipients = Array.isArray(to) ? to : [to];
    if (recipients.length === 0) return;

    if (this.resend) {
      try {
        const { error } = await this.resend.emails.send({
          from: this.fromEmail,
          to: recipients,
          subject,
          html,
        });

        if (error) {
          this.logger.error(
            `Resend delivery error for [${subject}] to ${recipients.join(', ')}: ${error.message}`,
          );
        } else {
          this.logger.log(
            `Email [${subject}] delivered to ${recipients.join(', ')}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        this.logger.error(
          `Exception sending email to ${recipients.join(', ')}: ${msg}`,
          stack,
        );
      }
    } else {
      this.logger.log(
        `[SIMULATED EMAIL] From: ${this.fromEmail} | To: ${recipients.join(', ')} | Subject: ${subject}`,
      );
    }
  }

  // 1. New application submitted (Staff notification)
  async sendApplicationSubmittedStaff(
    staffEmails: string[],
    data: {
      studentName: string;
      track?: string;
      course?: string;
      school?: string;
      applicationId: number;
    },
  ) {
    const html = buildApplicationSubmittedStaffHtml(data, this.frontendUrl);
    await this.sendEmail(
      staffEmails,
      `[ViaScholar] New Application Submitted - ${data.studentName}`,
      html,
    );
  }

  // 2. Application submission confirmation (Student)
  async sendApplicationSubmittedStudent(
    studentEmail: string,
    data: { studentName: string; track?: string; applicationId: number },
  ) {
    const html = buildApplicationSubmittedStudentHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      'Application Received - ViaScholar',
      html,
    );
  }

  // 3. Interview Scheduled (Student)
  async sendInterviewScheduled(
    studentEmail: string,
    data: {
      studentName: string;
      interviewAt: Date;
      meetingLink?: string;
      notes?: string;
    },
  ) {
    const html = buildInterviewScheduledHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      'Interview Scheduled: ViaScholar Scholarship Program',
      html,
    );
  }

  // 4. Student requested interview reschedule (Staff notification)
  async sendInterviewRescheduleRequestedStaff(
    staffEmails: string[],
    data: {
      studentName: string;
      reason: string;
      applicationId: number;
    },
  ) {
    const html = buildInterviewRescheduleRequestedStaffHtml(
      data,
      this.frontendUrl,
    );
    await this.sendEmail(
      staffEmails,
      `[Action Needed] Interview Reschedule Request - ${data.studentName}`,
      html,
    );
  }

  // 5. Interview Rescheduled (Student)
  async sendInterviewRescheduled(
    studentEmail: string,
    data: {
      studentName: string;
      newInterviewAt: Date;
      meetingLink?: string;
      notes?: string;
    },
  ) {
    const html = buildInterviewRescheduledHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      'Interview Rescheduled: ViaScholar Scholarship Program',
      html,
    );
  }

  // 5b. Interview Cancelled (Student)
  async sendInterviewCancelled(
    studentEmail: string,
    data: {
      studentName: string;
      scheduledAt?: Date;
      reason?: string;
    },
  ) {
    const html = buildInterviewCancelledHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      'Interview Cancelled: ViaScholar Scholarship Program',
      html,
    );
  }

  // 6. Stage updated (Student)
  async sendStageUpdated(
    studentEmail: string,
    data: {
      studentName: string;
      stage: string;
      status: string;
      notes?: string;
    },
  ) {
    const html = buildStageUpdatedHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      `Application Update: ${data.stage}`,
      html,
    );
  }

  // 7. Application Approved (Student)
  async sendApplicationApproved(
    studentEmail: string,
    data: { studentName: string; track?: string },
  ) {
    const html = buildApplicationApprovedHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      '🎉 Congratulations! Your ViaScholar Application is Approved',
      html,
    );
  }

  // 8. Application Rejected (Student)
  async sendApplicationRejected(
    studentEmail: string,
    data: { studentName: string; reason?: string },
  ) {
    const html = buildApplicationRejectedHtml(data);
    await this.sendEmail(
      studentEmail,
      'ViaScholar Application Status Update',
      html,
    );
  }

  // 9. Contract Issued & Ready to Sign (Student)
  async sendContractReadyToSign(
    studentEmail: string,
    data: { studentName: string; contractNumber: string },
  ) {
    const html = buildContractReadyToSignHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      'Action Required: Sign Your ViaScholar Scholarship Agreement',
      html,
    );
  }

  // 10. Contract Signed - Student Welcome
  async sendContractSignedStudent(
    studentEmail: string,
    data: { studentName: string; contractNumber: string },
  ) {
    const html = buildContractSignedStudentHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      'Welcome to ViaScholar - Contract Executed',
      html,
    );
  }

  // 11. Contract Signed - Staff Notification
  async sendContractSignedStaff(
    staffEmails: string[],
    data: { studentName: string; contractNumber: string },
  ) {
    const html = buildContractSignedStaffHtml(data, this.frontendUrl);
    await this.sendEmail(
      staffEmails,
      `[Signed] Contract Executed - ${data.studentName}`,
      html,
    );
  }

  // 11b. Contract Change Requested - Staff Notification
  async sendContractChangeRequestToStaff(
    staffEmails: string[],
    data: {
      studentName: string;
      studentEmail: string;
      contractNumber: string;
      reason: string;
    },
  ) {
    const html = buildContractChangeRequestToStaffHtml(data, this.frontendUrl);
    await this.sendEmail(
      staffEmails,
      `[Revision Requested] Contract #${data.contractNumber} - ${data.studentName}`,
      html,
    );
  }

  // 12. Document Action Required (Student)
  async sendDocumentActionRequired(
    studentEmail: string,
    data: {
      studentName: string;
      documentType: string;
      reason?: string;
    },
  ) {
    const html = buildDocumentActionRequiredHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      `[Action Required] Re-upload Document: ${data.documentType}`,
      html,
    );
  }

  // 13. Grade Report Status Evaluated (Scholar)
  async sendGradeReportStatusUpdated(
    studentEmail: string,
    data: {
      studentName: string;
      academicYear: string;
      semester: string;
      status: string;
      remarks?: string;
    },
  ) {
    const html = buildGradeReportStatusUpdatedHtml(data, this.frontendUrl);
    await this.sendEmail(
      studentEmail,
      `Grade Report Update: ${data.status} (A.Y. ${data.academicYear} ${data.semester})`,
      html,
    );
  }
}
