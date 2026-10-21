/**
 * RFQ Service
 * Generates RFQ emails for suppliers and logs dispatch records.
 * Tokens are UUIDs stored in RFQDispatches and expire after TOKEN_EXPIRY_DAYS.
 *
 * Also sends a short notification email to the Director(s) whenever a
 * supplier submits (or updates) a quotation through their public link,
 * so someone knows to log in and evaluate it without having to poll the
 * "Pending Evaluation" list. Procurement dept is CC'd on the same email
 * (2026-07-30) — they can view the evaluation page but not pick a winner,
 * so this keeps them aware of which suppliers have responded without
 * needing to poll the page themselves.
 */
const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../logger');

const TOKEN_EXPIRY_DAYS =
  parseInt(process.env.RFQ_TOKEN_EXPIRY_DAYS, 10) || 7;

let _transporter = null;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.port === 465,
      auth: { user: config.email.user, pass: config.email.pass },
      tls: { rejectUnauthorized: false },
    });
  }
  return _transporter;
}

function tokenExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + TOKEN_EXPIRY_DAYS);
  return d;
}

// Shared comma-separated-env-var parser — same normalization used for
// both directorEmails and procurementEmails, so trailing spaces/empty
// entries in the .env value never turn into a broken "to"/"cc" header.
function parseEmailList(raw) {
  return (raw || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * Build the HTML body for an RFQ email.
 */
function buildRFQEmailHtml({ rfqNumber, deadline, items, supplierName, submitUrl, notes }) {
  const deadlineStr = deadline
    ? new Date(deadline).toLocaleDateString('en-KE', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      })
    : 'As soon as possible';

  const itemRows = items
    .map(
      (it, i) => `
        <tr style="background:${i % 2 === 0 ? '#f9fafb' : '#fff'}">
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">${i + 1}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">
            ${it.ItemName}
            ${it.ReferencePhotoUrl ? `<br><a href="${config.appUrl}${it.ReferencePhotoUrl}" target="_blank"><img src="${config.appUrl}${it.ReferencePhotoUrl}" alt="Reference photo" style="max-width:120px;max-height:120px;margin-top:6px;border-radius:4px;border:1px solid #e5e7eb;display:block;"></a>` : ''}
          </td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:right;">${Number(it.Qty).toLocaleString()}${it.Unit ? ` ${it.Unit}` : ''}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">${it.Category || '—'}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">${it.PreferredBrand || '—'}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">${it.PreferredQuality || '—'}</td>
        </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0"
        style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">

        <!-- Header -->
        <tr>
          <td style="background:#1e3a5f;padding:20px 32px;color:#fff;">
            <h1 style="margin:0;font-size:20px;">Njoro Canning Factory</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:.85;">
              Request for Quotation — ${rfqNumber}
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:24px 32px;">
            <p style="margin:0 0 12px;font-size:15px;color:#333;">
              Dear <strong>${supplierName}</strong>,
            </p>
            <p style="margin:0 0 16px;font-size:14px;color:#555;">
              Njoro Canning Factory invites you to submit a quotation for the items listed
              below. Please provide unit prices inclusive of all applicable taxes and charges.
            </p>

            <!-- Deadline callout -->
            <div style="background:#fef3c7;border-left:4px solid #f59e0b;
                        padding:12px 16px;border-radius:4px;margin-bottom:20px;">
              <strong style="font-size:14px;color:#92400e;">
                Quotation Deadline: ${deadlineStr}
              </strong>
            </div>

            <!-- Items table -->
            <table width="100%" cellpadding="0" cellspacing="0"
              style="border-collapse:collapse;font-size:13px;margin-bottom:20px;">
              <thead>
                <tr style="background:#1e3a5f;color:#fff;">
                  <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:left;">#</th>
                  <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:left;">Item Description</th>
                  <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:right;">Qty Required</th>
                  <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:left;">Category</th>
                  <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:left;">Brand</th>
                  <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:left;">Quality</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>

            ${notes ? `<p style="font-size:13px;color:#555;margin-bottom:16px;"><strong>Additional Notes:</strong> ${notes}</p>` : ''}

            <!-- Submit button -->
            <div style="text-align:center;margin:24px 0;">
              <a href="${submitUrl}"
                style="display:inline-block;background:#1a73e8;color:#fff;
                       padding:14px 32px;border-radius:6px;font-size:15px;
                       font-weight:bold;text-decoration:none;">
                Submit Your Quotation Online
              </a>
            </div>
            <p style="font-size:12px;color:#888;text-align:center;margin:0 0 16px;">
              Or reply to this email with your pricing details.<br>
              This link expires in ${TOKEN_EXPIRY_DAYS} days.
            </p>

            <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">
            <p style="font-size:12px;color:#999;margin:0;">
              Njoro Canning Factory · P.O. Box 100, Njoro, Kenya<br>
              This is an automated message. Do not reply if you do not wish to participate.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Send RFQ email to one supplier.
 * Returns true on success, false on failure (does not throw — failure is logged).
 */
async function sendRFQEmail({ to, supplierName, rfqNumber, deadline, items, submitUrl, notes }) {
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"Njoro Canning Factory Procurement" <${config.email.from}>`,
      to,
      subject: `Request for Quotation — ${rfqNumber} | Njoro Canning Factory`,
      html: buildRFQEmailHtml({ rfqNumber, deadline, items, supplierName, submitUrl, notes }),
    });
    logger.info(`[RFQService] Email sent to ${to} for ${rfqNumber}`);
    return true;
  } catch (err) {
    logger.error(`[RFQService] Email failed to ${to}:`, err);
    return false;
  }
}

/**
 * Build the short HTML body for the Director notification email.
 */
function buildDirectorNotificationHtml({ rfqNumber, supplierName, totalAmount, isUpdate, evaluationUrl }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
        style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#1e3a5f;padding:20px 32px;color:#fff;">
            <h1 style="margin:0;font-size:20px;">Njoro Canning Factory</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:.85;">Procurement — Quotation ${isUpdate ? 'Updated' : 'Received'}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px;">
            <p style="margin:0 0 16px;font-size:15px;color:#333;">
              <strong>${supplierName}</strong> has ${isUpdate ? 'updated their' : 'submitted a'} quotation
              for <strong>${rfqNumber}</strong>${totalAmount ? ` totalling <strong>KES ${Number(totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>` : ''}.
            </p>
            <div style="text-align:center;margin:24px 0;">
              <a href="${evaluationUrl}"
                style="display:inline-block;background:#1a73e8;color:#fff;
                       padding:14px 32px;border-radius:6px;font-size:15px;
                       font-weight:bold;text-decoration:none;">
                Review &amp; Select Winner
              </a>
            </div>
            <p style="font-size:12px;color:#888;text-align:center;margin:0;">
              Log in to Material Traceability to compare all quotations for this RFQ.
            </p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">
            <p style="font-size:12px;color:#999;margin:0;">
              Njoro Canning Factory · Automated procurement notification.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Notify the Director(s) that a supplier has submitted or updated a
 * quotation, so they know to log in and evaluate it. Non-fatal on failure —
 * a Director missing one email shouldn't roll back or block the supplier's
 * submission; they'll still see it in the "Pending Evaluation" list.
 *
 * Procurement dept (config.email.procurementEmails) is CC'd on the same
 * email — they can view the evaluation page (read-only) but can't pick a
 * winner, so CC'ing them here is how they find out a supplier responded
 * without needing to poll the page. If no procurementEmails are configured,
 * the email still goes out to Directors alone — CC is additive, never
 * required.
 */
async function notifyDirectorsOfQuotation({ rfqNumber, rfqId, supplierName, totalAmount, isUpdate = false }) {
  const recipients = parseEmailList(config.email.directorEmails);
  const ccRecipients = parseEmailList(config.email.procurementEmails);

  if (recipients.length === 0) {
    logger.warn('[RFQService] No directorEmails configured — skipping director notification');
    return false;
  }

  const evaluationUrl = `${config.appUrl}/director/evaluation?rfqId=${rfqId}`;

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"Njoro Canning Factory Procurement" <${config.email.from}>`,
      to: recipients.join(','),
      ...(ccRecipients.length > 0 ? { cc: ccRecipients.join(',') } : {}),
      subject: `Quotation ${isUpdate ? 'updated' : 'received'} — ${rfqNumber} (${supplierName})`,
      html: buildDirectorNotificationHtml({ rfqNumber, supplierName, totalAmount, isUpdate, evaluationUrl }),
    });
    logger.info(
      `[RFQService] Director notification sent for ${rfqNumber} (${supplierName})` +
      (ccRecipients.length > 0 ? ` — cc'd Procurement (${ccRecipients.length})` : '')
    );
    return true;
  } catch (err) {
    logger.error(`[RFQService] Director notification failed for ${rfqNumber}:`, err);
    return false;
  }
}

module.exports = {
  sendRFQEmail,
  tokenExpiryDate,
  TOKEN_EXPIRY_DAYS,
  notifyDirectorsOfQuotation,
};