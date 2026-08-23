/**
 * Email templates
 * ---------------
 * Every outgoing message is built here so wording and branding stay in one
 * place. Each builder returns { subject, html, text } - plain-text alternatives
 * are always included (spam filters penalise HTML-only mail, and some players
 * read on locked-down school accounts that strip HTML).
 *
 * Table-based layout with inline styles on purpose: Outlook and Gmail's clipper
 * ignore <style> blocks and modern CSS. Keep it boring and it renders anywhere.
 */
const { sendMail } = require('./mailer');

const GREEN_DARK = '#1a3a2a';
const GREEN_MID = '#2d5c3e';
const MUTED = '#6b7a70';
const BORDER = '#e2e8e4';

function appUrl() {
  return (process.env.APP_URL || 'https://www.collegegolfmetrics.com').replace(/\/+$/, '');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Shared shell: logo bar, white card, footer. `preheader` is the inbox preview line. */
function layout({ heading, preheader, bodyHtml }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f7f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f5;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="padding:0 4px 16px;font:700 18px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${GREEN_DARK};">
        &#9971; College Golf <span style="color:${GREEN_MID};font-weight:600;">Metrics</span>
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid ${BORDER};border-radius:12px;padding:28px 30px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${GREEN_DARK};">
        <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:${GREEN_DARK};">${esc(heading)}</h1>
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:16px 4px 0;font:12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};">
        College Golf Metrics - tendency-first stats for college golf programs.<br>
        <a href="${appUrl()}" style="color:${MUTED};">${appUrl().replace(/^https?:\/\//, '')}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;">
    <tr><td style="background:${GREEN_MID};border-radius:8px;">
      <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font:700 15px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;">${esc(label)}</a>
    </td></tr></table>`;
}

function fallbackLink(url) {
  return `<p style="margin:18px 0 0;font-size:12.5px;color:${MUTED};">If the button doesn't work, paste this into your browser:<br>
    <a href="${esc(url)}" style="color:${GREEN_MID};word-break:break-all;">${esc(url)}</a></p>`;
}

// -- Invite ------------------------------------------------------------------
function inviteTemplate({ teamName, coachName, inviteUrl, expiresDays = 7 }) {
  const team = teamName || 'your team';
  const from = coachName ? `${coachName} has` : 'Your coach has';
  return {
    subject: `${coachName ? coachName + ' invited you' : "You're invited"} to join ${team} on College Golf Metrics`,
    text: `${from} invited you to join ${team} on College Golf Metrics.

Set up your player account here (link expires in ${expiresDays} days):
${inviteUrl}

Once you're in you can log rounds from your phone during play, and your coach sees your stats and the team board automatically.

- College Golf Metrics
${appUrl()}`,
    html: layout({
      heading: `You're invited to join ${esc(team)}`,
      preheader: `${from} invited you to track your rounds on College Golf Metrics.`,
      bodyHtml: `
        <p style="margin:0 0 4px;">${esc(from)} invited you to join <strong>${esc(team)}</strong> on College Golf Metrics.</p>
        <p style="margin:12px 0 0;">Set up your player account and you can log rounds from your phone as you play - shot by shot or after the round. Your coach sees your stats, your trends, and the team board automatically.</p>
        ${button(inviteUrl, 'Set up my account')}
        <p style="margin:0;font-size:13px;color:${MUTED};">This invitation expires in ${expiresDays} days.</p>
        ${fallbackLink(inviteUrl)}`,
    }),
  };
}

// -- Welcome (sent once the player accepts) ----------------------------------
function welcomeTemplate({ playerName, teamName }) {
  const url = appUrl();
  const first = String(playerName || '').split(' ')[0] || 'there';
  return {
    subject: `You're on the roster - welcome to College Golf Metrics`,
    text: `Hi ${first},

You're set up on ${teamName || 'your team'} in College Golf Metrics.

Three things to try first:
1. Log a round - Mobile Capture is built for entering holes as you play.
2. Check your reports - every round feeds your tendencies and season averages.
3. Watch the leaderboard - see where you sit on your team and in the rankings.

Start here: ${url}/app/index.html

- College Golf Metrics`,
    html: layout({
      heading: `Welcome, ${esc(first)} - you're on the roster`,
      preheader: `You're set up on ${esc(teamName || 'your team')}. Here's how to start.`,
      bodyHtml: `
        <p style="margin:0;">Your player account on <strong>${esc(teamName || 'your team')}</strong> is ready. Three things worth doing first:</p>
        <ol style="margin:14px 0 0;padding-left:20px;">
          <li style="margin-bottom:8px;"><strong>Log a round.</strong> Mobile Capture is built for entering holes as you play.</li>
          <li style="margin-bottom:8px;"><strong>Read your report.</strong> Every round feeds your tendencies and season averages - no extra work.</li>
          <li><strong>Check the leaderboard.</strong> See where you sit on your team, and in the national rankings.</li>
        </ol>
        ${button(url + '/app/index.html', 'Open my dashboard')}
        <p style="margin:0;font-size:13px;color:${MUTED};">Questions? Just reply to this email.</p>`,
    }),
  };
}

// -- Password reset ----------------------------------------------------------
function resetTemplate({ name, resetUrl, expiresMinutes = 60 }) {
  const first = String(name || '').split(' ')[0] || 'there';
  return {
    subject: 'Reset your College Golf Metrics password',
    text: `Hi ${first},

Someone asked to reset the password on your College Golf Metrics account. If that was you, use this link (it expires in ${expiresMinutes} minutes and works once):

${resetUrl}

If it wasn't you, ignore this email - your password stays as it is.

- College Golf Metrics`,
    html: layout({
      heading: 'Reset your password',
      preheader: `Your password reset link expires in ${expiresMinutes} minutes.`,
      bodyHtml: `
        <p style="margin:0;">Hi ${esc(first)} - someone asked to reset the password on your College Golf Metrics account.</p>
        ${button(resetUrl, 'Choose a new password')}
        <p style="margin:0;font-size:13px;color:${MUTED};">This link expires in ${expiresMinutes} minutes and can only be used once. If you didn't ask for it, you can ignore this email - your password won't change.</p>
        ${fallbackLink(resetUrl)}`,
    }),
  };
}

// -- Senders (never throw; return the mailer's {sent, reason} result) ---------
const sendInviteEmail = (to, data) => sendMail({ to, ...inviteTemplate(data) });
const sendWelcomeEmail = (to, data) => sendMail({ to, ...welcomeTemplate(data) });
const sendPasswordResetEmail = (to, data) => sendMail({ to, ...resetTemplate(data) });

module.exports = {
  sendInviteEmail, sendWelcomeEmail, sendPasswordResetEmail,
  inviteTemplate, welcomeTemplate, resetTemplate, // exported for tests / preview
};
