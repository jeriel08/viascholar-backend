import { renderBaseEmail } from './base.template.js';

export function buildInterviewScheduledHtml(
  data: {
    studentName: string;
    interviewAt: Date;
    meetingLink?: string;
    notes?: string;
  },
  frontendUrl: string,
): string {
  const formattedDate = data.interviewAt.toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
  });

  return renderBaseEmail({
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
          url: `${frontendUrl}/applicant/status`,
        },
    footerNotes:
      'Cannot attend? You can request a reschedule directly from your ViaScholar dashboard.',
  });
}

export function buildInterviewRescheduleRequestedStaffHtml(
  data: {
    studentName: string;
    reason: string;
    applicationId: number;
  },
  frontendUrl: string,
): string {
  return renderBaseEmail({
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
      url: `${frontendUrl}/dashboard/applications/${data.applicationId}`,
    },
  });
}

export function buildInterviewCancelledHtml(
  data: {
    studentName: string;
    scheduledAt?: Date;
    reason?: string;
  },
  frontendUrl: string,
): string {
  const formattedDate = data.scheduledAt?.toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
  });

  return renderBaseEmail({
    title: 'Interview Cancelled',
    badge: { text: 'Cancelled', variant: 'danger' },
    greeting: `Dear ${data.studentName},`,
    bodyHtml: `
      <p>Your scholarship interview has been cancelled and will be rescheduled soon.</p>
      <div class="details-box">
        ${
          formattedDate
            ? `<div class="detail-row"><span class="detail-label">Was Scheduled:</span><span class="detail-value">${formattedDate}</span></div>`
            : ''
        }
        ${
          data.reason
            ? `<div class="detail-row"><span class="detail-label">Reason:</span><span class="detail-value">${data.reason}</span></div>`
            : ''
        }
      </div>
      <p>Please wait for a new interview invitation from the ViaScholar staff.</p>
    `,
    cta: {
      text: 'View Application Status',
      url: `${frontendUrl}/applicant/status`,
    },
  });
}

export function buildInterviewRescheduledHtml(
  data: {
    studentName: string;
    newInterviewAt: Date;
    meetingLink?: string;
    notes?: string;
  },
  frontendUrl: string,
): string {
  const formattedDate = data.newInterviewAt.toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
  });

  return renderBaseEmail({
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
          url: `${frontendUrl}/applicant/status`,
        },
  });
}
