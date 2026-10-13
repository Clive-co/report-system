// The notification email is deliberately minimal: it tells officials THAT a report arrived
// and where from, nothing more. No description, no street address, no informant details,
// no evidence, no attachments and no links to evidence. Email is stored on third-party
// servers and forwarded freely, so anything sensitive stays inside the case desk,
// where access is role-checked and audited.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

type ReportForEmail = {
  trackingCode: string;
  state: string;
  city: string;
  createdAt: Date;
  mediaCount: number;
  anonymous: boolean;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendReportNotification(report: ReportForEmail) {
  const dashboardUrl = process.env.PUBLIC_API_URL
    ? `${process.env.PUBLIC_API_URL.replace(/\/+$/, '')}/admin/`
    : null;

  const html = `
    <h2>New report received</h2>
    <p>
      <strong>Reference:</strong> ${escapeHtml(report.trackingCode)}<br/>
      <strong>Submitted:</strong> ${report.createdAt.toISOString()}<br/>
      <strong>State:</strong> ${escapeHtml(report.state)}<br/>
      <strong>City:</strong> ${escapeHtml(report.city)}<br/>
      <strong>Evidence files:</strong> ${report.mediaCount}<br/>
      <strong>Reporter:</strong> ${report.anonymous ? 'Anonymous' : 'Left contact details'}
    </p>
    <p style="color:#666;font-size:13px">
      For security, the report's details and evidence are not included in this email.
      Sign in to the ICPC case desk to review it${dashboardUrl ? `: ${escapeHtml(dashboardUrl)}` : '.'}
    </p>
  `;

  console.log(`[email] sending notification for ${report.trackingCode} to Brevo`);

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY!,
    },
    body: JSON.stringify({
      sender: { email: process.env.EMAIL_FROM, name: 'ICPC Reports' },
      to: [{ email: process.env.REPORT_NOTIFICATION_EMAIL }],
      bcc: process.env.INTERNAL_AUDIT_EMAIL ? [{ email: process.env.INTERNAL_AUDIT_EMAIL }] : undefined,
      subject: `New ICPC report from ${report.state}, ${report.city}`,
      htmlContent: html,
    }),
  });

  const responseText = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(`Brevo send failed: ${res.status} ${responseText}`);
  }

  // Brevo returns { messageId } on acceptance. Search for this id in
  // Brevo > Transactional > Logs to see whether it was delivered, blocked or bounced.
  console.log(`[email] Brevo accepted notification for ${report.trackingCode}: ${res.status} ${responseText}`);
}
