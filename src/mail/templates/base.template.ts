export interface BaseEmailOptions {
  title: string;
  badge?: {
    text: string;
    variant?: 'primary' | 'success' | 'warning' | 'danger' | 'info';
  };
  greeting?: string;
  bodyHtml: string;
  cta?: {
    text: string;
    url: string;
  };
  footerNotes?: string;
}

export function renderBaseEmail(options: BaseEmailOptions): string {
  const badgeColors: Record<string, { bg: string; text: string }> = {
    primary: { bg: '#e0e7ff', text: '#3730a3' },
    success: { bg: '#dcfce7', text: '#166534' },
    warning: { bg: '#fef3c7', text: '#92400e' },
    danger: { bg: '#fee2e2', text: '#991b1b' },
    info: { bg: '#e0f2fe', text: '#075985' },
  };

  const badgeStyle = options.badge
    ? badgeColors[options.badge.variant || 'primary'] || badgeColors.primary
    : null;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${options.title}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f4f6f8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      line-height: 1.6;
    }
    .wrapper {
      width: 100%;
      background-color: #f4f6f8;
      padding: 40px 0;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
      border: 1px solid #e2e8f0;
    }
    .header {
      background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%);
      padding: 28px 32px;
      text-align: left;
    }
    .brand-name {
      color: #ffffff;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin: 0;
    }
    .brand-sub {
      color: #bfdbfe;
      font-size: 13px;
      margin: 4px 0 0 0;
    }
    .content {
      padding: 32px;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .heading {
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
      margin: 0 0 16px 0;
      line-height: 1.3;
    }
    .greeting {
      font-size: 15px;
      font-weight: 600;
      color: #334155;
      margin-bottom: 16px;
    }
    .body-text {
      font-size: 15px;
      color: #475569;
    }
    .details-box {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px 20px;
      margin: 20px 0;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 14px;
      border-bottom: 1px dashed #e2e8f0;
    }
    .detail-row:last-child {
      border-bottom: none;
    }
    .detail-label {
      color: #64748b;
      font-weight: 500;
    }
    .detail-value {
      color: #0f172a;
      font-weight: 600;
      text-align: right;
    }
    .btn-container {
      text-align: center;
      margin: 28px 0 12px 0;
    }
    .btn {
      display: inline-block;
      background-color: #2563eb;
      color: #ffffff !important;
      text-decoration: none;
      padding: 12px 28px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 15px;
      box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2);
    }
    .footer {
      background-color: #f8fafc;
      padding: 20px 32px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      font-size: 13px;
      color: #94a3b8;
    }
    .footer p {
      margin: 4px 0;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1 class="brand-name">ViaScholar</h1>
        <p class="brand-sub">Scholarship Evaluation & Management System</p>
      </div>
      <div class="content">
        ${
          badgeStyle
            ? `<div class="badge" style="background-color: ${badgeStyle.bg}; color: ${badgeStyle.text};">${options.badge!.text}</div>`
            : ''
        }
        <h2 class="heading">${options.title}</h2>
        ${options.greeting ? `<div class="greeting">${options.greeting}</div>` : ''}
        <div class="body-text">
          ${options.bodyHtml}
        </div>
        ${
          options.cta
            ? `
        <div class="btn-container">
          <a href="${options.cta.url}" class="btn" target="_blank">${options.cta.text}</a>
        </div>
        `
            : ''
        }
      </div>
      <div class="footer">
        ${options.footerNotes ? `<p>${options.footerNotes}</p>` : ''}
        <p>© ${new Date().getFullYear()} ViaScholar. All rights reserved.</p>
        <p>This is an automated notification. Please do not reply directly to this email.</p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}
