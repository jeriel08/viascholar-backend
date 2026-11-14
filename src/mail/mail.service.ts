import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { PrismaService } from '../prisma/prisma.service.js';
import { SmsService } from '../sms/sms.service.js';
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
import { buildPasswordResetHtml } from './templates/password-reset.template.js';
import { buildTwoFactorOtpHtml } from './templates/two-factor.template.js';
import {
  USER_SETTINGS_AUDIT_ACTION,
  parseUserSettings,
} from '../auth/user-settings.util.js';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private resend: Resend | null = null;
  private fromEmail: string;
  private frontendUrl: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    @Optional() private smsService?: SmsService,
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

  private async filterEnabledRecipients(
    recipients: string[],
  ): Promise<string[]> {
    if (!this.prisma.user?.findMany || !this.prisma.auditLog?.findMany) {
      return recipients;
    }

    try {
      const users = await this.prisma.user.findMany({
        where: { email: { in: recipients } },
        select: { user_id: true, email: true },
      });
      if (!Array.isArray(users) || users.length === 0) {
        return recipients;
      }

      const logs = await this.prisma.auditLog.findMany({
        where: {
          user_id: { in: users.map((u) => u.user_id) },
          action: USER_SETTINGS_AUDIT_ACTION,
        },
        orderBy: { created_at: 'desc' },
      });
      if (!Array.isArray(logs) || logs.length === 0) {
        return recipients;
      }

      const latestByUser = new Map<number, string | null>();
      for (const entry of logs) {
        if (entry.user_id != null && !latestByUser.has(entry.user_id)) {
          latestByUser.set(entry.user_id, entry.details);
        }
      }

      const disabledEmails = new Set<string>();
      for (const user of users) {
        const details = latestByUser.get(user.user_id);
        if (details && !parseUserSettings(details).emailNotifs && user.email) {
          disabledEmails.add(user.email.toLowerCase());
        }
      }

      return recipients.filter(
        (email) => !disabledEmails.has(email.toLowerCase()),
      );
    } catch {
      return recipients;
    }
  }

  // Core email dispatch method
  private async sendEmail(
    to: string | string[],
    subject: string,
    html: string,
    options?: { bypassPreferences?: boolean },
  ): Promise<void> {
    const rawRecipients = Array.isArray(to) ? to : [to];
    if (rawRecipients.length === 0) return;

    const recipients = options?.bypassPreferences
      ? rawRecipients
      : await this.filterEnabledRecipients(rawRecipients);
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

  private async sendStudentSmsByEmail(
    studentEmail: string,
    message: string,
  ): Promise<void> {
    if (
      !this.smsService ||
      !studentEmail ||
      typeof this.prisma.user?.findUnique !== 'function'
    ) {
      return;
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { email: studentEmail },
        select: {
          user_id: true,
          scholar_profile: {
            select: { phone_number: true },
          },
        },
      });
      const phone = user?.scholar_profile?.phone_number?.trim();
      if (!user || !phone) {
        return;
      }

      await this.smsService.sendNotificationSms(user.user_id, phone, message);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to send SMS notification to ${studentEmail}: ${msg}`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Hi ${data.studentName}, your scholarship application (#${data.applicationId}) has been received and is under review.`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Hi ${data.studentName}, your scholarship interview is scheduled for ${data.interviewAt.toISOString()}. Check your portal for details.`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Hi ${data.studentName}, your scholarship interview was rescheduled to ${data.newInterviewAt.toISOString()}. Check your portal for details.`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Hi ${data.studentName}, your scheduled scholarship interview has been cancelled.${data.reason ? ` Reason: ${data.reason}` : ''}`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Hi ${data.studentName}, your application stage "${data.stage}" was updated to ${data.status}.`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Congratulations ${data.studentName}! Your scholarship application${data.track ? ` (${data.track})` : ''} has been approved.`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Hi ${data.studentName}, there is a status update on your scholarship application. Please check your portal for details.`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Hi ${data.studentName}, your scholarship agreement (#${data.contractNumber}) is ready to sign in your portal.`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Welcome to ViaScholar, ${data.studentName}! Your scholarship agreement (#${data.contractNumber}) has been executed.`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Action required: Please re-upload your ${data.documentType} document in the ViaScholar portal.${data.reason ? ` Reason: ${data.reason}` : ''}`,
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
    await this.sendStudentSmsByEmail(
      studentEmail,
      `[ViaScholar] Hi ${data.studentName}, your grade report for A.Y. ${data.academicYear} ${data.semester} was updated to ${data.status}.`,
    );
  }

  // 14. Password Reset Email
  async sendPasswordResetEmail(
    email: string,
    data: {
      userName: string;
      resetUrl: string;
      expiresInMinutes: number;
    },
  ) {
    const html = buildPasswordResetHtml(data);
    await this.sendEmail(email, 'Reset Your Password - ViaScholar', html, {
      bypassPreferences: true,
    });
  }

  // 15. Two-Factor OTP Verification Email
  async sendTwoFactorOtpEmail(
    email: string,
    data: {
      userName: string;
      code: string;
      expiresInMinutes: number;
    },
  ): Promise<{ simulated: boolean }> {
    const html = buildTwoFactorOtpHtml(data);
    await this.sendEmail(
      email,
      'Your Two-Factor Verification Code - ViaScholar',
      html,
      { bypassPreferences: true },
    );
    return { simulated: !this.resend };
  }
}
