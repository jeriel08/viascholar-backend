import { renderBaseEmail } from './base.template.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface DeadlineFollowUpEmailData {
  studentName: string;
  requirementLabel: string;
  academicYear: string;
  semester: string;
  dueDateLabel: string;
  isOverdue: boolean;
  daysOverdue?: number;
  coordinatorName: string;
  message: string;
  actionPath: string;
}

export function buildDeadlineFollowUpHtml(
  data: DeadlineFollowUpEmailData,
  frontendUrl: string,
): string {
  const safeStudent = escapeHtml(data.studentName || 'Scholar');
  const safeReq = escapeHtml(data.requirementLabel);
  const safeAy = escapeHtml(data.academicYear);
  const safeSem = escapeHtml(data.semester);
  const safeDue = escapeHtml(data.dueDateLabel);
  const safeCoordinator = escapeHtml(data.coordinatorName || 'Coordinator');
  const safeMessage = escapeHtml(data.message).replace(/\r?\n/g, '<br/>');

  const statusText = data.isOverdue
    ? `Overdue${data.daysOverdue ? ` by ${data.daysOverdue} day${data.daysOverdue === 1 ? '' : 's'}` : ''}`
    : 'Pending Submission';

  return renderBaseEmail({
    title: data.isOverdue
      ? `${data.requirementLabel} Submission Overdue`
      : `${data.requirementLabel} Submission Reminder`,
    badge: {
      text: data.isOverdue ? 'Overdue Reminder' : 'Submission Reminder',
      variant: data.isOverdue ? 'danger' : 'warning',
    },
    greeting: `Dear ${safeStudent},`,
    bodyHtml: `
      <p>Your Scholarship Coordinator (<strong>${safeCoordinator}</strong>) is following up regarding your pending <strong>${safeReq}</strong> submission for <strong>A.Y. ${safeAy} - ${safeSem}</strong>.</p>
      <div class="details-box">
        <div class="detail-row"><span class="detail-label">Requirement:</span><span class="detail-value">${safeReq}</span></div>
        <div class="detail-row"><span class="detail-label">Academic Term:</span><span class="detail-value">A.Y. ${safeAy} · ${safeSem}</span></div>
        <div class="detail-row"><span class="detail-label">Due Date:</span><span class="detail-value">${safeDue}</span></div>
        <div class="detail-row"><span class="detail-label">Status:</span><span class="detail-value">${statusText}</span></div>
      </div>
      <div class="details-box" style="margin-top: 12px;">
        <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Message from ${safeCoordinator}:</div>
        <div style="font-size: 13px; color: #1e293b; line-height: 1.55;">${safeMessage}</div>
      </div>
      <p style="margin-top: 14px;">If your school has not released your documents yet or you are experiencing a delay, please reply in ViaScholar Messages so your Coordinator can note your status. You can still submit your requirements directly through the portal.</p>
    `,
    cta: {
      text: `Submit ${data.requirementLabel} Now`,
      url: `${frontendUrl}${data.actionPath}`,
    },
    footerNotes: `You may also reply directly in ViaScholar Messages (<a href="${frontendUrl}/scholarMessage">Open Messages</a>).`,
  });
}
