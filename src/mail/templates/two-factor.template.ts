import { renderBaseEmail } from './base.template.js';

export function buildTwoFactorOtpHtml(params: {
  userName: string;
  code: string;
  expiresInMinutes: number;
}): string {
  const { userName, code, expiresInMinutes } = params;

  const bodyHtml = `
    <p>Use the verification code below to enable <strong>Two-Factor Authentication (Email OTP)</strong> on your <strong>ViaScholar</strong> account.</p>
    <div style="margin: 24px 0; padding: 18px 24px; background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px; text-align: center;">
      <p style="margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; font-weight: 600;">Verification Code</p>
      <p style="margin: 0; font-size: 32px; font-weight: 700; letter-spacing: 0.25em; color: #1a2d4f; font-family: monospace;">${code}</p>
    </div>
    <p style="font-size: 13px; color: #475569;">
      This code will expire in <strong>${expiresInMinutes} minutes</strong>. If you did not initiate this request, you can safely ignore this email.
    </p>
  `;

  return renderBaseEmail({
    title: 'Two-Factor Verification Code - ViaScholar',
    badge: {
      text: 'Security Verification',
      variant: 'primary',
    },
    greeting: `Hello ${userName || 'there'},`,
    bodyHtml,
  });
}
