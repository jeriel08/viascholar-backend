import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { PrismaService } from '../prisma/prisma.service.js';
import { renderBaseEmail } from './templates/base.template.js';

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
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch staff emails: ${error?.message || error}`,
      );
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
      } catch (err: any) {
        this.logger.error(
          `Exception sending email to ${recipients.join(', ')}: ${err?.message || err}`,
          err?.stack,
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
    const html = renderBaseEmail({
      title: 'New Scholarship Application Submitted',
      badge: { text: 'New Submission', variant: 'info' },
      greeting: 'Hello ViaScholar Staff,',
      bodyHtml: `
        <p>A new scholarship application has been submitted and is awaiting evaluation.</p>
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Applicant Name:</span><span class="detail-value">${data.studentName}</span></div>
          <div class="detail-row"><span class="detail-label">Scholarship Track:</span><span class="detail-value">${data.track || 'General'}</span></div>
          <div class="detail-row"><span class="detail-label">Course / Program:</span><span class="detail-value">${data.course || 'N/A'}</span></div>
          <div class="detail-row"><span class="detail-label">School / University:</span><span class="detail-value">${data.school || 'N/A'}</span></div>
          <div class="detail-row"><span class="detail-label">Application ID:</span><span class="detail-value">#${data.applicationId}</span></div>
        </div>
      `,
      cta: {
        text: 'Review Application in Dashboard',
        url: `${this.frontendUrl}/dashboard/applications/${data.applicationId}`,
      },
    });

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
    const html = renderBaseEmail({
      title: 'Application Received',
      badge: { text: 'Submitted', variant: 'primary' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>Thank you for applying to the <strong>ViaScholar Scholarship Program</strong>. We have received your application and supporting documents.</p>
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Application ID:</span><span class="detail-value">#${data.applicationId}</span></div>
          <div class="detail-row"><span class="detail-label">Selected Track:</span><span class="detail-value">${data.track || 'General'}</span></div>
          <div class="detail-row"><span class="detail-label">Initial Status:</span><span class="detail-value">Under Review</span></div>
        </div>
        <p>Our evaluation team will review your submitted documents and academic records. You will receive an email whenever your application stage is updated.</p>
      `,
      cta: {
        text: 'Track Application Status',
        url: `${this.frontendUrl}/applicant/status`,
      },
    });

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
    const formattedDate = data.interviewAt.toLocaleString('en-US', {
      dateStyle: 'full',
      timeStyle: 'short',
    });

    const html = renderBaseEmail({
      title: 'Interview Scheduled',
      badge: { text: 'Interview', variant: 'warning' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>Your scholarship interview with the grantor/evaluation committee has been scheduled.</p>
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Date & Time:</span><span class="detail-value">${formattedDate}</span></div>
          ${
            data.meetingLink
              ? `<div class="detail-row"><span class="detail-label">Platform:</span><span class="detail-value">Google Meet</span></div>`
              : ''
          }
          ${
            data.notes
              ? `<div class="detail-row"><span class="detail-label">Instructions:</span><span class="detail-value">${data.notes}</span></div>`
              : ''
          }
        </div>
        <p>Please ensure you have a stable internet connection and are in a quiet environment 5 minutes prior to the scheduled time.</p>
      `,
      cta: data.meetingLink
        ? {
            text: 'Join Google Meet Interview',
            url: data.meetingLink,
          }
        : {
            text: 'View Interview Details',
            url: `${this.frontendUrl}/applicant/status`,
          },
      footerNotes:
        'Cannot attend? You can request a reschedule directly from your ViaScholar dashboard.',
    });

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
    const html = renderBaseEmail({
      title: 'Interview Reschedule Request',
      badge: { text: 'Action Needed', variant: 'warning' },
      greeting: 'Hello ViaScholar Staff,',
      bodyHtml: `
        <p>An applicant has requested to reschedule their scholarship interview.</p>
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Applicant:</span><span class="detail-value">${data.studentName}</span></div>
          <div class="detail-row"><span class="detail-label">Application ID:</span><span class="detail-value">#${data.applicationId}</span></div>
          <div class="detail-row"><span class="detail-label">Reason & Notes:</span><span class="detail-value">${data.reason}</span></div>
        </div>
        <p>Please review the applicant's availability in the dashboard and set a new interview date.</p>
      `,
      cta: {
        text: 'Reschedule Interview in Dashboard',
        url: `${this.frontendUrl}/dashboard/applications/${data.applicationId}`,
      },
    });

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
    const formattedDate = data.newInterviewAt.toLocaleString('en-US', {
      dateStyle: 'full',
      timeStyle: 'short',
    });

    const html = renderBaseEmail({
      title: 'Interview Rescheduled',
      badge: { text: 'Updated Schedule', variant: 'info' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>Your scholarship interview has been rescheduled to a new date and time.</p>
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">New Date & Time:</span><span class="detail-value">${formattedDate}</span></div>
          ${
            data.meetingLink
              ? `<div class="detail-row"><span class="detail-label">Platform:</span><span class="detail-value">Google Meet</span></div>`
              : ''
          }
          ${
            data.notes
              ? `<div class="detail-row"><span class="detail-label">Notes:</span><span class="detail-value">${data.notes}</span></div>`
              : ''
          }
        </div>
      `,
      cta: data.meetingLink
        ? {
            text: 'Join Google Meet Interview',
            url: data.meetingLink,
          }
        : {
            text: 'View Updated Schedule',
            url: `${this.frontendUrl}/applicant/status`,
          },
    });

    await this.sendEmail(
      studentEmail,
      'Interview Rescheduled: ViaScholar Scholarship Program',
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
    const html = renderBaseEmail({
      title: 'Application Progress Update',
      badge: { text: data.stage, variant: 'primary' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>There is an update on your scholarship application evaluation.</p>
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Current Stage:</span><span class="detail-value">${data.stage}</span></div>
          <div class="detail-row"><span class="detail-label">Overall Status:</span><span class="detail-value">${data.status}</span></div>
          ${
            data.notes
              ? `<div class="detail-row"><span class="detail-label">Feedback / Notes:</span><span class="detail-value">${data.notes}</span></div>`
              : ''
          }
        </div>
        <p>You can check the live progress tracker in your applicant portal.</p>
      `,
      cta: {
        text: 'View Application Timeline',
        url: `${this.frontendUrl}/applicant/status`,
      },
    });

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
    const html = renderBaseEmail({
      title: '🎉 Congratulations! Your Application is Approved',
      badge: { text: 'Approved', variant: 'success' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>We are delighted to inform you that your application for the <strong>ViaScholar Scholarship Program (${data.track || 'General Track'})</strong> has been <strong>APPROVED</strong>!</p>
        <p>Our team is preparing your official Scholarship Agreement / Contract. Once issued, you will receive a notification to review and sign your contract.</p>
        <p>Congratulations on reaching this milestone!</p>
      `,
      cta: {
        text: 'Go to Applicant Portal',
        url: `${this.frontendUrl}/applicant/status`,
      },
    });

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
    const html = renderBaseEmail({
      title: 'ViaScholar Application Status Update',
      badge: { text: 'Decision Notice', variant: 'danger' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>Thank you for your interest in the ViaScholar Scholarship Program and for taking the time to apply.</p>
        <p>After careful evaluation of this cycle's applicants, we regret to inform you that we are unable to offer you a scholarship at this time.</p>
        ${
          data.reason
            ? `
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Committee Feedback:</span><span class="detail-value">${data.reason}</span></div>
        </div>
        `
            : ''
        }
        <p>We encourage you to apply again in future academic cycles.</p>
      `,
    });

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
    const html = renderBaseEmail({
      title: 'Scholarship Agreement Ready for Signature',
      badge: { text: 'Signature Required', variant: 'warning' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>Your official scholarship contract (<strong>#${data.contractNumber}</strong>) is now ready for your review and electronic signature.</p>
        <p>Signing this agreement will officially activate your status as a <strong>ViaScholar Scholar</strong>.</p>
      `,
      cta: {
        text: 'Review & Sign Contract',
        url: `${this.frontendUrl}/applicant/contract`,
      },
    });

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
    const html = renderBaseEmail({
      title: 'Welcome to the ViaScholar Program!',
      badge: { text: 'Official Scholar', variant: 'success' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>Your scholarship contract (<strong>#${data.contractNumber}</strong>) has been successfully executed and recorded.</p>
        <p>Your account has now been promoted to <strong>SCHOLAR</strong> status. You can now access full scholar features including grade submissions, disbursement tracking, and program announcements.</p>
      `,
      cta: {
        text: 'Access Scholar Portal',
        url: `${this.frontendUrl}/scholar/dashboard`,
      },
    });

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
    const html = renderBaseEmail({
      title: 'Contract Executed & Scholar Promoted',
      badge: { text: 'Contract Signed', variant: 'success' },
      greeting: 'Hello ViaScholar Staff,',
      bodyHtml: `
        <p>Scholar contract <strong>#${data.contractNumber}</strong> has been signed by <strong>${data.studentName}</strong>.</p>
        <p>The student has been officially promoted to active Scholar status.</p>
      `,
      cta: {
        text: 'View Contracts in Dashboard',
        url: `${this.frontendUrl}/dashboard/contracts`,
      },
    });

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
    const html = renderBaseEmail({
      title: 'Contract Revision Requested by Student',
      badge: { text: 'Revision Requested', variant: 'warning' },
      greeting: 'Hello ViaScholar Staff,',
      bodyHtml: `
        <p>Student <strong>${data.studentName}</strong> (${data.studentEmail}) has reviewed pending contract <strong>#${data.contractNumber}</strong> and requested revisions prior to signing.</p>
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Contract Number:</span><span class="detail-value">#${data.contractNumber}</span></div>
          <div class="detail-row"><span class="detail-label">Student:</span><span class="detail-value">${data.studentName} (${data.studentEmail})</span></div>
          <div class="detail-row"><span class="detail-label">Requested Corrections:</span><span class="detail-value">${data.reason}</span></div>
        </div>
        <p>Please review the student's profile and contract details in the staff dashboard to make the necessary adjustments and re-issue the agreement.</p>
      `,
      cta: {
        text: 'Manage Contracts in Dashboard',
        url: `${this.frontendUrl}/dashboard/contracts`,
      },
    });

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
    const html = renderBaseEmail({
      title: 'Document Re-upload Required',
      badge: { text: 'Action Required', variant: 'warning' },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>During the verification of your scholarship documents, an issue was detected with your <strong>${data.documentType}</strong>.</p>
        ${
          data.reason
            ? `
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Reason / Feedback:</span><span class="detail-value">${data.reason}</span></div>
        </div>
        `
            : ''
        }
        <p>Please upload a clearer or updated copy to proceed with your application review.</p>
      `,
      cta: {
        text: 'Re-upload Document',
        url: `${this.frontendUrl}/applicant/documents`,
      },
    });

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
    const variant =
      data.status === 'APPROVED'
        ? 'success'
        : data.status === 'FLAGGED'
          ? 'warning'
          : 'danger';

    const html = renderBaseEmail({
      title: 'Grade Report Evaluation Update',
      badge: { text: data.status, variant },
      greeting: `Dear ${data.studentName},`,
      bodyHtml: `
        <p>Your grade report for <strong>A.Y. ${data.academicYear} - ${data.semester}</strong> has been reviewed.</p>
        <div class="details-box">
          <div class="detail-row"><span class="detail-label">Evaluation Status:</span><span class="detail-value">${data.status}</span></div>
          ${
            data.remarks
              ? `<div class="detail-row"><span class="detail-label">Staff Remarks:</span><span class="detail-value">${data.remarks}</span></div>`
              : ''
          }
        </div>
      `,
      cta: {
        text: 'View Grade Monitoring Details',
        url: `${this.frontendUrl}/scholar/grades`,
      },
    });

    await this.sendEmail(
      studentEmail,
      `Grade Report Update: ${data.status} (A.Y. ${data.academicYear} ${data.semester})`,
      html,
    );
  }
}
