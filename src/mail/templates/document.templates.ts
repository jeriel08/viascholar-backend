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
