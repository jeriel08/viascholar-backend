import { renderBaseEmail } from './base.template.js';

export function buildApplicationSubmittedStaffHtml(
  data: {
    studentName: string;
    track?: string;
    course?: string;
    school?: string;
    applicationId: number;
  },
  frontendUrl: string,
): string {
  return renderBaseEmail({
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
      url: `${frontendUrl}/dashboard/applications/${data.applicationId}`,
    },
  });
}

export function buildApplicationSubmittedStudentHtml(
  data: { studentName: string; track?: string; applicationId: number },
  frontendUrl: string,
): string {
  return renderBaseEmail({
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
      url: `${frontendUrl}/applicant/status`,
    },
  });
}

export function buildStageUpdatedHtml(
  data: {
    studentName: string;
    stage: string;
    status: string;
    notes?: string;
  },
  frontendUrl: string,
): string {
  return renderBaseEmail({
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
      url: `${frontendUrl}/applicant/status`,
    },
  });
}

export function buildApplicationApprovedHtml(
  data: { studentName: string; track?: string },
  frontendUrl: string,
): string {
  return renderBaseEmail({
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
      url: `${frontendUrl}/applicant/status`,
    },
  });
}

export function buildApplicationRejectedHtml(data: {
  studentName: string;
  reason?: string;
}): string {
  return renderBaseEmail({
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
}
