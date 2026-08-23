/**
 * Mailer
 * ------
 * Transactional email for College Golf Metrics, sent over the Google Workspace
 * mailbox (admin@collegegolfmetrics.com) via SMTP. The domain already carries
 * SPF + DKIM + DMARC for Google, so mail sent this way authenticates cleanly.
 *
 * Design rules:
 *  1. **Never throw.** A failed send must never fail the request that triggered
 *     it - a coach's invite still gets created, and the copyable link is still
 *     returned as a fallback. Every caller gets {sent, reason|error} instead.
 *  2. **Degrade loudly, not silently.** Unconfigured or failing sends are
 *     console-warned and written to error_log so they surface in the admin
 *     console rather than disappearing.
 *  3. Templates live in ./emails.js; this file only knows how to send.
 *
 * Config (Railway env vars):
 *   SMTP_USER   admin@collegegolfmetrics.com
 *   SMTP_PASS   16-char Google App Password (requires 2-Step Verification)
 *   MAIL_FROM   optional display form, default: College Golf Metrics <SMTP_USER>
 *   SMTP_HOST   optional, default smtp.gmail.com
 *   SMTP_PORT   optional, default 465 (implicit TLS)
 *   MAIL_REPLY_TO optional Reply-To for all mail
 */
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* dependency missing - handled below */ }

let transporter = null;
let warnedOnce = false;

function isConfigured() {
  return Boolean(nodemailer && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function fromAddress() {
  return process.env.MAIL_FROM || `College Golf Metrics <${process.env.SMTP_USER}>`;
}

function getTransport() {
  if (transporter) return transporter;
  if (!isConfigured()) return null;
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

function warnUnconfigured(subject, to) {
  console.warn(`[mail] NOT SENT (no SMTP config) -> "${subject}" to ${to}`);
  if (!warnedOnce) {
    warnedOnce = true;
    console.warn('[mail] Set SMTP_USER and SMTP_PASS to enable outgoing email. ' +
                 'See DEPLOY_BETA.md -> "Email (invites, resets, welcome)".');
  }
}

/**
 * Send one message. Resolves {sent:true, id} on success, or {sent:false, reason}
 * - it never rejects.
 */
async function sendMail({ to, subject, html, text, replyTo }) {
  if (!to || !subject) return { sent: false, reason: 'missing_recipient_or_subject' };

  const tx = getTransport();
  if (!tx) {
    warnUnconfigured(subject, to);
    return { sent: false, reason: nodemailer ? 'not_configured' : 'nodemailer_missing' };
  }

  try {
    const info = await tx.sendMail({
      from: fromAddress(),
      to,
      subject,
      text: text || undefined,
      html: html || undefined,
      replyTo: replyTo || process.env.MAIL_REPLY_TO || undefined,
    });
    console.log(`[mail] sent "${subject}" -> ${to} (${info.messageId})`);
    return { sent: true, id: info.messageId };
  } catch (err) {
    console.error(`[mail] FAILED "${subject}" -> ${to}:`, err.message);
    // Best-effort surfacing in the admin console; must not throw.
    try { require('./errorLog').logError('mail', err, {}); } catch (_) {}
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

/** Startup check - verifies credentials so a bad App Password shows up in logs. */
async function verifyTransport() {
  const tx = getTransport();
  if (!tx) {
    console.warn('[mail] outgoing email is DISABLED (SMTP_USER / SMTP_PASS not set)');
    return { ok: false, reason: nodemailer ? 'not_configured' : 'nodemailer_missing' };
  }
  try {
    await tx.verify();
    console.log(`✉️  Email ready - sending as ${fromAddress()}`);
    return { ok: true };
  } catch (err) {
    console.error('[mail] SMTP verify failed:', err.message);
    return { ok: false, reason: 'verify_failed', error: err.message };
  }
}

module.exports = { sendMail, verifyTransport, isConfigured, fromAddress };
