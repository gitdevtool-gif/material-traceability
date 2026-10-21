const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../logger');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.port === 465,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
      tls: { rejectUnauthorized: false },
    });
  }
  return transporter;
}

/**
 * Send Ops Manager approval email with Approve/Reject links
 */
async function sendOpsApprovalEmail({ to, entryNo, supplierName, consignmentNo, vehicleRegNo, materialNames, ticketNos, acceptedQty, rejectedQty, qaDecision, qaRemarks, inspectorName, approveToken, rejectToken }) {
  const baseUrl = config.appUrl;
  const approveUrl = `${baseUrl}/api/ops-approval/token/${approveToken}?action=approve`;
  const rejectUrl = `${baseUrl}/api/ops-approval/token/${rejectToken}?action=reject`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:#1e3a5f;padding:20px 32px;color:#fff;">
            <h1 style="margin:0;font-size:20px;">Njoro Canning Factory</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:0.85;">Material Traceability — Ops Manager Approval Required</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:24px 32px;">
            <p style="margin:0 0 16px;font-size:15px;color:#333;">
              A delivery has passed QA inspection and requires your approval before receiving.
            </p>
            <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;font-size:14px;color:#333;">
              <tr style="background:#f9fafb;">
                <td style="font-weight:bold;width:40%;border-bottom:1px solid #e5e7eb;">Entry No</td>
                <td style="border-bottom:1px solid #e5e7eb;">${entryNo}</td>
              </tr>
              <tr>
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Supplier</td>
                <td style="border-bottom:1px solid #e5e7eb;">${supplierName}</td>
              </tr>
              <tr style="background:#f9fafb;">
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Consignment</td>
                <td style="border-bottom:1px solid #e5e7eb;">${consignmentNo}</td>
              </tr>
              <tr>
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Vehicle</td>
                <td style="border-bottom:1px solid #e5e7eb;">${vehicleRegNo}</td>
              </tr>
              ${ticketNos ? `
              <tr style="background:#f9fafb;">
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Weighbridge Ticket No(s)</td>
                <td style="border-bottom:1px solid #e5e7eb;font-weight:600;color:#1e3a5f;">${ticketNos}</td>
              </tr>` : ''}
              <tr style="background:#f9fafb;">
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Material(s)</td>
                <td style="border-bottom:1px solid #e5e7eb;">${materialNames}</td>
              </tr>
              <tr>
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">QA Decision</td>
                <td style="border-bottom:1px solid #e5e7eb;">
                  <span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-weight:600;">${qaDecision}</span>
                </td>
              </tr>
              <tr style="background:#f9fafb;">
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Accepted Qty</td>
                <td style="border-bottom:1px solid #e5e7eb;">${acceptedQty != null ? acceptedQty + ' kg' : '—'}</td>
              </tr>
              <tr>
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Rejected Qty</td>
                <td style="border-bottom:1px solid #e5e7eb;">${rejectedQty > 0 ? rejectedQty + ' kg' : '0'}</td>
              </tr>
              <tr style="background:#f9fafb;">
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Inspector</td>
                <td style="border-bottom:1px solid #e5e7eb;">${inspectorName || '—'}</td>
              </tr>
              <tr>
                <td style="font-weight:bold;">QA Remarks</td>
                <td>${qaRemarks || '—'}</td>
              </tr>
            </table>

            <p style="margin:24px 0 16px;font-size:15px;color:#333;font-weight:600;">
              Please review and take action:
            </p>

            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:8px;">
                  <a href="${approveUrl}" style="display:inline-block;padding:14px 40px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-size:16px;font-weight:bold;letter-spacing:0.5px;">
                    ✅ APPROVE
                  </a>
                </td>
                <td align="center" style="padding:8px;">
                  <a href="${rejectUrl}" style="display:inline-block;padding:14px 40px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;font-size:16px;font-weight:bold;letter-spacing:0.5px;">
                    ❌ REJECT
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">
              These links are single-use and expire in 48 hours. You can also log in to the system to review with full details.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
              njorocanning@2026 all rights reserved — Material Traceability System
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const info = await getTransporter().sendMail({
      from: `"Njoro Canning Factory" <${config.email.from}>`,
      to,
      subject: `🔔 Approval Required — ${entryNo} | ${supplierName}`,
      html,
    });
    logger.info(`Ops approval email sent for ${entryNo} to ${to}`, { messageId: info.messageId });
    return true;
  } catch (err) {
    logger.error(`Failed to send ops approval email for ${entryNo}`, { error: err.message });
    return false;
  }
}

/**
 * Send Requisition Ops-Approval email — sent automatically as soon as a
 * factory-floor requisition lands in 'PendingOpsApproval' (see
 * procurement-sync.service.js). Two links, deliberately NOT a mirror of
 * sendOpsApprovalEmail's Approve/Reject pair:
 *   - Approve All: approves every item at its full requested qty (same
 *     as clicking "Approve All" then "Submit Decision" in the app).
 *   - Hold for Review: puts the whole requisition on hold, no reason
 *     needed — safe/reversible.
 * No one-click "Reject" — requisition-approval.routes.js requires a
 * reason per rejected item, which a single email click can't supply;
 * rejecting still requires logging in.
 */
async function sendRequisitionApprovalEmail({ to, busyOrdNo, warehouse, matCenter, busyDate, items, approveToken, holdToken }) {
  const baseUrl = config.appUrl;
  const approveUrl = `${baseUrl}/api/procurement/requisition-approval/token/${approveToken}?action=approve`;
  const holdUrl = `${baseUrl}/api/procurement/requisition-approval/token/${holdToken}?action=hold`;

  const itemRows = (items || []).map((it, i) => `
    <tr style="${i % 2 === 0 ? 'background:#f9fafb;' : ''}">
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${it.ItemName}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;">${Number(it.Qty).toLocaleString()}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${it.Category || '—'}</td>
    </tr>`).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:#1e3a5f;padding:20px 32px;color:#fff;">
            <h1 style="margin:0;font-size:20px;">Njoro Canning Factory</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:0.85;">Material Traceability — Requisition Approval Required</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:24px 32px;">
            <p style="margin:0 0 16px;font-size:15px;color:#333;">
              A factory-floor requisition has synced from Busy and needs your review before Procurement can act on it.
            </p>
            <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;font-size:14px;color:#333;margin-bottom:16px;">
              <tr style="background:#f9fafb;">
                <td style="font-weight:bold;width:40%;border-bottom:1px solid #e5e7eb;">Busy Ord No</td>
                <td style="border-bottom:1px solid #e5e7eb;">${busyOrdNo}</td>
              </tr>
              <tr>
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Warehouse</td>
                <td style="border-bottom:1px solid #e5e7eb;">${warehouse || '—'}</td>
              </tr>
              <tr style="background:#f9fafb;">
                <td style="font-weight:bold;border-bottom:1px solid #e5e7eb;">Mat Centre</td>
                <td style="border-bottom:1px solid #e5e7eb;">${matCenter || '—'}</td>
              </tr>
              <tr>
                <td style="font-weight:bold;">Date</td>
                <td>${busyDate ? new Date(busyDate).toLocaleDateString('en-KE') : '—'}</td>
              </tr>
            </table>

            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;font-size:13px;color:#333;">
              <tr style="background:#1e3a5f;color:#fff;">
                <td style="padding:8px 10px;font-weight:bold;">Item</td>
                <td style="padding:8px 10px;font-weight:bold;text-align:right;">Qty</td>
                <td style="padding:8px 10px;font-weight:bold;">Category</td>
              </tr>
              ${itemRows}
            </table>

            <p style="margin:24px 0 16px;font-size:15px;color:#333;font-weight:600;">
              Please review and take action:
            </p>

            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:8px;">
                  <a href="${approveUrl}" style="display:inline-block;padding:14px 32px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;letter-spacing:0.5px;">
                    ✅ APPROVE ALL ITEMS
                  </a>
                </td>
                <td align="center" style="padding:8px;">
                  <a href="${holdUrl}" style="display:inline-block;padding:14px 32px;background:#d97706;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;letter-spacing:0.5px;">
                    ⏸ HOLD FOR REVIEW
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">
              "Approve All" approves every item above at its full requested quantity. To reject specific
              items with a reason, or approve only some, please log in to the system instead. These links
              are single-use and expire in 48 hours.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
              njorocanning@2026 all rights reserved — Material Traceability System
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const info = await getTransporter().sendMail({
      from: `"Njoro Canning Factory" <${config.email.from}>`,
      to,
      subject: `🔔 Requisition Approval Required — ${busyOrdNo}`,
      html,
    });
    logger.info(`Requisition approval email sent for ${busyOrdNo} to ${to}`, { messageId: info.messageId });
    return true;
  } catch (err) {
    logger.error(`Failed to send requisition approval email for ${busyOrdNo}`, { error: err.message });
    return false;
  }
}

module.exports = { sendOpsApprovalEmail, sendRequisitionApprovalEmail };
