import { renderBaseEmail } from './base.template.js';

export function buildDocumentActionRequiredHtml(
  data: {
    studentName: string;
    documentType: string;
    reason?: string;
  },
  frontendUrl: string,
): string {
  return renderBaseEmail({
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
      url: `${frontendUrl}/applicant/documents`,
    },
  });
}

export function buildGradeReportStatusUpdatedHtml(
  data: {
    studentName: string;
    academicYear: string;
    semester: string;
    status: string;
    remarks?: string;
  },
  frontendUrl: string,
): string {
  const variant =
    data.status === 'APPROVED'
      ? 'success'
      : data.status === 'FLAGGED'
        ? 'warning'
        : 'danger';

  return renderBaseEmail({
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
      url: `${frontendUrl}/scholar/grades`,
    },
  });
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildAcademicChangeRequestToStaffHtml(
  data: {
    studentName: string;
    changeLabel: string;
    currentSummary: string;
    requestedSummary: string;
    reason: string;
    effectiveTerm?: string | null;
  },
  frontendUrl: string,
): string {
  return renderBaseEmail({
    title: `${data.changeLabel} Request`,
    badge: { text: 'Awaiting Grantor Confirmation', variant: 'warning' },
    greeting: 'Dear Grantor (CC: Scholarship Coordinator),',
    bodyHtml: `
      <p><strong>${escapeHtml(data.studentName)}</strong> has submitted a formal request for a <strong>${escapeHtml(data.changeLabel)}</strong>.</p>
      <div class="details-box">
        <div class="detail-row"><span class="detail-label">Current Academic Setup:</span><span class="detail-value">${escapeHtml(data.currentSummary)}</span></div>
        <div class="detail-row"><span class="detail-label">Requested Change:</span><span class="detail-value">${escapeHtml(data.requestedSummary)}</span></div>
        ${
          data.effectiveTerm
            ? `<div class="detail-row"><span class="detail-label">Effective Term:</span><span class="detail-value">${escapeHtml(data.effectiveTerm)}</span></div>`
            : ''
        }
        <div class="detail-row"><span class="detail-label">Reason:</span><span class="detail-value">${escapeHtml(data.reason)}</span></div>
      </div>
      <p>Grantors may confirm or decline this request directly in the Monitor panel. Coordinators are copied for awareness and baseline review readiness.</p>
    `,
    cta: {
      text: 'Review Shift Request',
      url: `${frontendUrl}/grantMonitor?tab=shift-requests`,
    },
  });
}

export function buildAcademicChangeDecisionHtml(
  data: {
    studentName: string;
    changeLabel: string;
    requestedSummary: string;
    decision: 'APPROVED' | 'DENIED';
    decisionNotes?: string | null;
  },
  frontendUrl: string,
): string {
  const approved = data.decision === 'APPROVED';
  return renderBaseEmail({
    title: `${data.changeLabel} ${approved ? 'Confirmed' : 'Declined'}`,
    badge: {
      text: approved ? 'Confirmed by Grantor' : 'Declined',
      variant: approved ? 'success' : 'danger',
    },
    greeting: `Dear ${escapeHtml(data.studentName)},`,
    bodyHtml: `
      <p>${
        approved
          ? `Your request for <strong>${escapeHtml(data.changeLabel)}</strong> (<strong>${escapeHtml(data.requestedSummary)}</strong>) has been confirmed by the Grantor (CC: Scholarship Coordinator).`
          : `Your request for <strong>${escapeHtml(data.changeLabel)}</strong> (<strong>${escapeHtml(data.requestedSummary)}</strong>) was declined by the Grantor.`
      }</p>
      ${
        data.decisionNotes
          ? `<div class="details-box"><div class="detail-row"><span class="detail-label">Grantor Notes:</span><span class="detail-value">${escapeHtml(data.decisionNotes)}</span></div></div>`
          : ''
      }
      <p>${
        approved
          ? 'Your profile has been updated and your Curriculum Prospectus has been unlocked so you can upload your updated program prospectus for Coordinator baseline verification.'
          : 'Your current program and school baseline remain unchanged.'
      }</p>
    `,
    cta: {
      text: 'Open Curriculum Prospectus',
      url: `${frontendUrl}/scholarProspectus`,
    },
  });
}
