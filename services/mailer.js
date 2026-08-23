/**
 * Mailer
 * ------
 * Transactional email for College Golf Metrics. Two transports, chosen by which
 * credentials are present:
 *
 *   1. RESEND_API_KEY  -> Resend's HTTPS API   (production, on Railway)
 *   2. SMTP_USER/PASS  -> SMTP via nodemailer  (local dev, or a host that allows it)
 *
 * WHY NOT SMTP IN PRODUCTION
 * Railway blocks outbound SMTP (ports 25/465/587) on Free, Trial and Hobby
 * plans - their docs direct you to "transactional email services with HTTPS
 * APIs". With SMTP the send doesn't get rejected, it never connects at all:
 * every message fails with "Connection timeout", which reads like an auth
 * problem and isn't. Resend goes out over 443 like any other API call.
 *
 * Design rules, unchanged:
 *  1. **Never throw.** A failed send must never fail the request that triggered
 *     it - a coach's invite still gets created, and the copyable link is still
 *     returned. Callers get {sent, reason|error}.
 *  2. **Degrade loudly.** Unconfigured or failing sends are console-warned and
 *     written to error_log so they surface in the admin console.
 *  3. Templates live in ./emails.js; this file only knows how to send.
 */
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* optional - only needed for SMTP */ }

let transporter = null;
let warnedOnce = false;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function provider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (nodemailer && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return null;
}
function isConfigured() { return provider() !== null; }

function fromAddress() {
  return process.env.MAIL_FROM
    || (process.env.SMTP_USER ? `College Golf Metrics <${process.env.SMTP_USER}>` : 'College Golf Metrics <admin@collegegolfmetrics.com>');
}

function getTransport() {
  if (transporter) return transporter;
  if (provider() !== 'smtp') return null;
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
  console.warn(`[mail] NOT SENT (no mail provider configured) -> "${subject}" to ${to}`);
  if (!warnedOnce) {
    warnedOnce = true;
    console.warn('[mail] Set RESEND_API_KEY (recommended) or SMTP_USER/SMTP_PASS. ' +
                 'See DEPLOY_BETA.md -> "Email (invites, resets, welcome)".');
  }
}

async function sendViaResend({ to, subject, html, text, replyTo }) {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject,
      html: html || undefined,
      text: text || undefined,
      reply_to: replyTo || process.env.MAIL_REPLY_TO || undefined,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Resend reports the real cause in `message` - unverified domain, bad key,
    // rate limit. Surface it rather than a bare status code.
    const err = new Error(body.message || `Resend returned ${res.status}`);
    err.statusCode = res.status;
    throw err;
  }
  return body.id;
}

/**
 * Send one message. Resolves {sent:true, id} on success, or {sent:false, reason}
 * - it never rejects.
 */
async function sendMail({ to, subject, html, text, replyTo }) {
  if (!to || !subject) return { sent: false, reason: 'missing_recipient_or_subject' };

  const kind = provider();
  if (!kind) {
    warnUnconfigured(subject, to);
    return { sent: false, reason: 'not_configured' };
  }

  try {
    let id;
    if (kind === 'resend') {
      id = await sendViaResend({ to, subject, html, text, replyTo });
    } else {
      const info = await getTransport().sendMail({
        from: fromAddress(), to, subject,
        text: text || undefined, html: html || undefined,
        replyTo: replyTo || process.env.MAIL_REPLY_TO || undefined,
      });
      id = info.messageId;
    }
    console.log(`[mail] sent via ${kind} "${subject}" -> ${to} (${id})`);
    return { sent: true, id };
  } catch (err) {
    console.error(`[mail] FAILED via ${kind} "${subject}" -> ${to}:`, err.message);
    try { require('./errorLog').logError('mail', err, {}); } catch (_) {}
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

/** Startup check - bad credentials show up in the boot log, not at 2am. */
async function verifyTransport() {
  const kind = provider();
  if (!kind) {
    console.warn('[mail] outgoing email is DISABLED (no RESEND_API_KEY, no SMTP_USER/SMTP_PASS)');
    return { ok: false, reason: 'not_configured' };
  }
  try {
    if (kind === 'resend') {
      const res = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      if (!res.ok) throw new Error(`Resend rejected the API key (${res.status})`);
    } else {
      await getTransport().verify();
    }
    console.log(`✉️  Email ready via ${kind} - sending as ${fromAddress()}`);
    return { ok: true, provider: kind };
  } catch (err) {
    console.error(`[mail] ${kind} verify failed:`, err.message);
    return { ok: false, reason: 'verify_failed', error: err.message, provider: kind };
  }
}

module.exports = { sendMail, verifyTransport, isConfigured, fromAddress, provider };
