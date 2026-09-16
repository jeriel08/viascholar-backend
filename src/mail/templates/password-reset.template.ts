import { renderBaseEmail } from './base.template.js';

export function buildPasswordResetHtml(params: {
  userName: string;
  resetUrl: string;
  expiresInMinutes: number;
}): string {
  const { userName, resetUrl, expiresInMinutes } = params;

  const bodyHtml = `
    <p>We received a request to reset your password for your <strong>ViaScholar</strong> account.</p>
    <p>Click the button below to choose a new password. For security reasons, this link will expire in <strong>${expiresInMinutes} minutes</strong>.</p>
    <div style="background-color: #f8fafc; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0; font-size: 13px; color: #475569;">
        If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
      </p>
    </div>
  `;

  return renderBaseEmail({
    title: 'Reset Your Password - ViaScholar',
    badge: {
      text: 'Security Notice',
      variant: 'warning',
    },
    greeting: `Hello ${userName || 'there'},`,
    bodyHtml,
    cta: {
      text: 'Reset Password',
      url: resetUrl,
    },
    footerNotes: `Link not working? Copy and paste this URL into your browser:<br/><span style="font-family: monospace; font-size: 11px; word-break: break-all; color: #64748b;">${resetUrl}</span>`,
  });
}
