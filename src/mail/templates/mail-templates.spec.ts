import { describe, expect, it } from 'vitest';

import { renderBaseEmail } from './base.template.js';
import {
  buildApplicationSubmittedStaffHtml,
  buildApplicationSubmittedStudentHtml,
  buildStageUpdatedHtml,
  buildApplicationApprovedHtml,
  buildApplicationRejectedHtml,
} from './application.templates.js';
import {
  buildInterviewScheduledHtml,
  buildInterviewRescheduleRequestedStaffHtml,
  buildInterviewRescheduledHtml,
  buildInterviewCancelledHtml,
} from './interview.templates.js';
import {
  buildContractReadyToSignHtml,
  buildContractSignedStudentHtml,
  buildContractSignedStaffHtml,
  buildContractChangeRequestToStaffHtml,
} from './contract.templates.js';
import {
  buildDocumentActionRequiredHtml,
  buildGradeReportStatusUpdatedHtml,
} from './document.templates.js';
import { buildPasswordResetHtml } from './password-reset.template.js';

const OUTCOME = {
  studentName: 'Juan Dela Cruz',
  track: 'Academic Track',
  course: 'BSIT',
  school: 'University of Mindanao',
  applicationId: 42,
};
const FRONTEND = 'https://app.example.com';

describe('renderBaseEmail', () => {
  it('renders the title, body, greeting, badge, and CTA', () => {
    const html = renderBaseEmail({
      title: 'Welcome',
      bodyHtml: '<p>Hello there</p>',
      greeting: 'Dear Juan,',
      badge: { text: 'New', variant: 'success' },
      cta: { text: 'Open', url: 'https://app.example.com/open' },
      footerNotes: 'Note',
    });

    expect(html).toContain('<title>Welcome</title>');
    expect(html).toContain('<p>Hello there</p>');
    expect(html).toContain('Dear Juan,');
    expect(html).toContain('New');
    expect(html).toContain('href="https://app.example.com/open"');
    expect(html).toContain('Note');
    expect(html).toContain('badge');
  });

  it('omits optional blocks when not provided', () => {
    const html = renderBaseEmail({
      title: 'Welcome',
      bodyHtml: '<p>Body</p>',
    });

    expect(html).not.toContain('class="greeting"');
    expect(html).not.toContain('class="badge"');
    expect(html).not.toContain('class="btn-container"');
  });

  it('falls back to the primary badge variant when an unknown variant is given', () => {
    const html = renderBaseEmail({
      title: 'Welcome',
      bodyHtml: '<p>Body</p>',
      badge: { text: 'First', variant: 'bogus' as never },
    });

    expect(html).toContain('#e0e7ff');
  });

  it('uses the danger badge color when variant is danger', () => {
    const html = renderBaseEmail({
      title: 'Welcome',
      bodyHtml: '<p>Body</p>',
      badge: { text: 'Alert', variant: 'danger' },
    });

    expect(html).toContain('#fee2e2');
  });
});

describe('application templates', () => {
  it('builds the staff notification with applicant details and CTA', () => {
    const html = buildApplicationSubmittedStaffHtml(OUTCOME, FRONTEND);

    expect(html).toContain('Juan Dela Cruz');
    expect(html).toContain('Academic Track');
    expect(html).toContain('BSIT');
    expect(html).toContain('University of Mindanao');
    expect(html).toContain('#42');
    expect(html).toContain(`${FRONTEND}/dashboard/applications/42`);
  });

  it('fills in missing student fields with placeholders for staff', () => {
    const html = buildApplicationSubmittedStaffHtml(
      { studentName: 'Ana', applicationId: 7 },
      FRONTEND,
    );

    expect(html).toContain('General');
    expect(html).toContain('N/A');
  });

  it('builds the student confirmation email', () => {
    const html = buildApplicationSubmittedStudentHtml(OUTCOME, FRONTEND);

    expect(html).toContain('Dear Juan Dela Cruz,');
    expect(html).toContain(`${FRONTEND}/applicant/status`);
  });

  it('builds the stage updated email with optional notes', () => {
    const withNotes = buildStageUpdatedHtml(
      {
        studentName: 'Juan Dela Cruz',
        stage: 'Interview Scheduled',
        status: 'UNDER_REVIEW',
        notes: 'Bring documents',
      },
      FRONTEND,
    );
    const withoutNotes = buildStageUpdatedHtml(
      {
        studentName: 'Juan Dela Cruz',
        stage: 'Interview Scheduled',
        status: 'UNDER_REVIEW',
      },
      FRONTEND,
    );

    expect(withNotes).toContain('Bring documents');
    expect(withoutNotes).not.toContain('Bring documents');
  });

  it('builds the approval email', () => {
    const html = buildApplicationApprovedHtml(OUTCOME, FRONTEND);

    expect(html).toContain('Congratulations');
    expect(html).toContain('Academic Track');
  });

  it('builds the rejection email with optional feedback', () => {
    const html = buildApplicationRejectedHtml({
      ...OUTCOME,
      reason: 'Incomplete records',
    });

    expect(html).toContain('Incomplete records');
  });
});

describe('interview templates', () => {
  it('builds the scheduled interview email with meeting link and Google Meet CTA', () => {
    const html = buildInterviewScheduledHtml(
      {
        studentName: 'Juan Dela Cruz',
        interviewAt: new Date('2026-08-20T10:00:00.000Z'),
        meetingLink: 'https://meet.google.com/abc',
        notes: 'Arrive early',
      },
      FRONTEND,
    );

    expect(html).toContain('Interview Scheduled');
    expect(html).toContain('Google Meet');
    expect(html).toContain('Arrive early');
    expect(html).toContain('https://meet.google.com/abc');
  });

  it('builds the scheduled interview email with fallback CTA without a link', () => {
    const html = buildInterviewScheduledHtml(
      {
        studentName: 'Juan Dela Cruz',
        interviewAt: new Date('2026-08-20T10:00:00.000Z'),
      },
      FRONTEND,
    );

    expect(html).toContain('View Interview Details');
    expect(html).toContain(`${FRONTEND}/applicant/status`);
  });

  it('builds the staff reschedule request notification', () => {
    const html = buildInterviewRescheduleRequestedStaffHtml(
      {
        studentName: 'Juan Dela Cruz',
        reason: 'Medical appointment',
        applicationId: 42,
      },
      FRONTEND,
    );

    expect(html).toContain('#42');
    expect(html).toContain('Medical appointment');
    expect(html).toContain(`${FRONTEND}/dashboard/applications/42`);
  });

  it('builds the cancelled interview email with optional schedule', () => {
    const html = buildInterviewCancelledHtml(
      {
        studentName: 'Juan Dela Cruz',
        scheduledAt: new Date('2026-08-20T10:00:00.000Z'),
        reason: 'Staff conflict',
      },
      FRONTEND,
    );

    expect(html).toContain('Interview Cancelled');
    expect(html).toContain('Staff conflict');
  });

  it('builds the cancelled interview email without a schedule', () => {
    const html = buildInterviewCancelledHtml(
      {
        studentName: 'Juan Dela Cruz',
      },
      FRONTEND,
    );

    expect(html).toContain('Interview Cancelled');
  });

  it('builds the rescheduled interview email', () => {
    const html = buildInterviewRescheduledHtml(
      {
        studentName: 'Juan Dela Cruz',
        newInterviewAt: new Date('2026-09-01T10:00:00.000Z'),
        meetingLink: 'https://meet.google.com/xyz',
      },
      FRONTEND,
    );

    expect(html).toContain('Interview Rescheduled');
    expect(html).toContain('Google Meet');
  });

  it('builds the rescheduled email with fallback CTA', () => {
    const html = buildInterviewRescheduledHtml(
      {
        studentName: 'Juan Dela Cruz',
        newInterviewAt: new Date('2026-09-01T10:00:00.000Z'),
      },
      FRONTEND,
    );

    expect(html).toContain('View Updated Schedule');
  });
});

describe('contract templates', () => {
  it('builds the ready-to-sign email', () => {
    const html = buildContractReadyToSignHtml(
      { studentName: 'Juan Dela Cruz', contractNumber: 'CTX-001' },
      FRONTEND,
    );

    expect(html).toContain('#CTX-001');
    expect(html).toContain(`${FRONTEND}/ApplicantsContract`);
  });

  it('builds the contract signed student email', () => {
    const html = buildContractSignedStudentHtml(
      { studentName: 'Juan Dela Cruz', contractNumber: 'CTX-001' },
      FRONTEND,
    );

    expect(html).toContain('Welcome to the ViaScholar Program!');
    expect(html).toContain(`${FRONTEND}/scholardashboard`);
  });

  it('builds the contract signed staff email', () => {
    const html = buildContractSignedStaffHtml(
      { studentName: 'Juan Dela Cruz', contractNumber: 'CTX-001' },
      FRONTEND,
    );

    expect(html).toContain('Juan Dela Cruz');
    expect(html).toContain(`${FRONTEND}/grantApplicants`);
  });

  it('builds the contract change request email', () => {
    const html = buildContractChangeRequestToStaffHtml(
      {
        studentName: 'Juan Dela Cruz',
        studentEmail: 'juan@example.com',
        contractNumber: 'CTX-001',
        reason: 'Typo in name',
      },
      FRONTEND,
    );

    expect(html).toContain('juan@example.com');
    expect(html).toContain('Typo in name');
    expect(html).toContain('#CTX-001');
  });
});

describe('document templates', () => {
  it('builds the document action required email with optional reason', () => {
    const html = buildDocumentActionRequiredHtml(
      {
        studentName: 'Juan Dela Cruz',
        documentType: 'TOR',
        reason: 'Blurry',
      },
      FRONTEND,
    );

    expect(html).toContain('TOR');
    expect(html).toContain('Blurry');
  });

  it('omits the reason block when none is provided', () => {
    const html = buildDocumentActionRequiredHtml(
      {
        studentName: 'Juan Dela Cruz',
        documentType: 'Form 138',
      },
      FRONTEND,
    );

    expect(html).toContain('Form 138');
    expect(html).not.toContain('Reason / Feedback');
  });

  it('picks the badge variant from the status', () => {
    const approved = buildGradeReportStatusUpdatedHtml(
      {
        studentName: 'Juan Dela Cruz',
        academicYear: '2025-2026',
        semester: '1st Semester',
        status: 'APPROVED',
      },
      FRONTEND,
    );
    const flagged = buildGradeReportStatusUpdatedHtml(
      {
        studentName: 'Juan Dela Cruz',
        academicYear: '2025-2026',
        semester: '1st Semester',
        status: 'FLAGGED',
      },
      FRONTEND,
    );
    const denied = buildGradeReportStatusUpdatedHtml(
      {
        studentName: 'Juan Dela Cruz',
        academicYear: '2025-2026',
        semester: '1st Semester',
        status: 'DENIED',
      },
      FRONTEND,
    );

    expect(approved).toContain('#dcfce7');
    expect(flagged).toContain('#fef3c7');
    expect(denied).toContain('#fee2e2');
  });

  it('includes optional remarks in the grade report email', () => {
    const withRemarks = buildGradeReportStatusUpdatedHtml(
      {
        studentName: 'Juan Dela Cruz',
        academicYear: '2025-2026',
        semester: '1st Semester',
        status: 'APPROVED',
        remarks: 'All clear',
      },
      FRONTEND,
    );
    const withoutRemarks = buildGradeReportStatusUpdatedHtml(
      {
        studentName: 'Juan Dela Cruz',
        academicYear: '2025-2026',
        semester: '1st Semester',
        status: 'APPROVED',
      },
      FRONTEND,
    );

    expect(withRemarks).toContain('All clear');
    expect(withoutRemarks).not.toContain('All clear');
  });
});

describe('password reset template', () => {
  it('embeds the reset URL and expiry minutes', () => {
    const html = buildPasswordResetHtml({
      userName: 'Juan',
      resetUrl: 'https://app.example.com/reset/abc',
      expiresInMinutes: 30,
    });

    expect(html).toContain('https://app.example.com/reset/abc');
    expect(html).toContain('30 minutes');
    expect(html).toContain('Hello Juan,');
  });

  it('greets a generic user when the name is missing', () => {
    const html = buildPasswordResetHtml({
      userName: '',
      resetUrl: 'https://app.example.com/reset/abc',
      expiresInMinutes: 30,
    });

    expect(html).toContain('Hello there,');
  });
});
