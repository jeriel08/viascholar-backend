import { renderBaseEmail } from './base.template.js';

export function buildContractReadyToSignHtml(
  data: { studentName: string; contractNumber: string },
  frontendUrl: string,
): string {
  return renderBaseEmail({
    title: 'Scholarship Agreement Ready for Signature',
    badge: { text: 'Signature Required', variant: 'warning' },
    greeting: `Dear ${data.studentName},`,
    bodyHtml: `
      <p>Your official scholarship contract (<strong>#${data.contractNumber}</strong>) is now ready for your review and electronic signature.</p>
      <p>Signing this agreement will officially activate your status as a <strong>ViaScholar Scholar</strong>.</p>
    `,
    cta: {
      text: 'Review & Sign Contract',
      url: `${frontendUrl}/applicant/contract`,
    },
  });
}

export function buildContractSignedStudentHtml(
  data: { studentName: string; contractNumber: string },
  frontendUrl: string,
): string {
  return renderBaseEmail({
    title: 'Welcome to the ViaScholar Program!',
    badge: { text: 'Official Scholar', variant: 'success' },
    greeting: `Dear ${data.studentName},`,
    bodyHtml: `
      <p>Your scholarship contract (<strong>#${data.contractNumber}</strong>) has been successfully executed and recorded.</p>
      <p>Your account has now been promoted to <strong>SCHOLAR</strong> status. You can now access full scholar features including grade submissions, disbursement tracking, and program announcements.</p>
    `,
    cta: {
      text: 'Access Scholar Portal',
      url: `${frontendUrl}/scholar/dashboard`,
    },
  });
}

export function buildContractSignedStaffHtml(
  data: { studentName: string; contractNumber: string },
  frontendUrl: string,
): string {
  return renderBaseEmail({
    title: 'Contract Executed & Scholar Promoted',
    badge: { text: 'Contract Signed', variant: 'success' },
    greeting: 'Hello ViaScholar Staff,',
    bodyHtml: `
      <p>Scholar contract <strong>#${data.contractNumber}</strong> has been signed by <strong>${data.studentName}</strong>.</p>
      <p>The student has been officially promoted to active Scholar status.</p>
    `,
    cta: {
      text: 'View Contracts in Dashboard',
      url: `${frontendUrl}/dashboard/contracts`,
    },
  });
}

export function buildContractChangeRequestToStaffHtml(
  data: {
    studentName: string;
    studentEmail: string;
    contractNumber: string;
    reason: string;
  },
  frontendUrl: string,
): string {
  return renderBaseEmail({
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
      url: `${frontendUrl}/dashboard/contracts`,
    },
  });
}
