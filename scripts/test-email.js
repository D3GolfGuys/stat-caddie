/**
 * SMTP smoke test.
 *
 *   npm run mail:test -- you@example.com
 *
 * Verifies the credentials in .env (or the shell environment), then sends one
 * real invite-shaped message to the address given. Use this before wiring a new
 * mailbox or App Password into Railway - it fails loudly and specifically,
 * which the app deliberately does not.
 */
require('dotenv').config();
const { verifyTransport, isConfigured, fromAddress } = require('../services/mailer');
const { inviteTemplate } = require('../services/emails');
const { sendMail } = require('../services/mailer');

(async () => {
  const to = process.argv[2];

  if (!isConfigured()) {
    console.error('✖ No mail provider configured. Set RESEND_API_KEY (or SMTP_USER/SMTP_PASS) — see .env.example.');
    process.exit(1);
  }
  console.log(`→ Sending as: ${fromAddress()}`);
  console.log(`→ Provider: ${require('../services/mailer').provider()}`);

  const v = await verifyTransport();
  if (!v.ok) {
    console.error(`✖ Credentials rejected (${v.reason}): ${v.error || ''}`);
    console.error('  Resend: check the API key, and that MAIL_FROM uses a domain verified in Resend.');
    console.error('  SMTP: many hosts (Railway Hobby included) block outbound SMTP entirely.');
    process.exit(1);
  }
  console.log('✔ SMTP credentials accepted.');

  if (!to) {
    console.log('\nNo recipient given — stopping before send.');
    console.log('To send a real test message:  npm run mail:test -- you@example.com');
    process.exit(0);
  }

  const tpl = inviteTemplate({
    teamName: 'Test Team',
    coachName: 'College Golf Metrics',
    inviteUrl: `${(process.env.APP_URL || 'https://www.collegegolfmetrics.com').replace(/\/+$/, '')}/accept-invite.html?token=TEST-TOKEN`,
  });
  const result = await sendMail({ to, ...tpl });
  if (result.sent) {
    console.log(`✔ Test invite sent to ${to} (${result.id})`);
    console.log('  Check the inbox AND the spam folder, and confirm the sender shows as authenticated.');
    process.exit(0);
  }
  console.error(`✖ Send failed (${result.reason}): ${result.error || ''}`);
  process.exit(1);
})();
