// Central list of platform-owner (admin) emails. Configure with ADMIN_EMAILS
// (comma-separated) or the legacy ADMIN_EMAIL. Defaults to the founder's
// address AND the admin@ mailbox so either can sign in as owner.
const RAW = process.env.ADMIN_EMAILS
  || process.env.ADMIN_EMAIL
  || 'mdeckert24@gmail.com,admin@collegegolfmetrics.com';

const ADMIN_EMAILS = new Set(
  RAW.split(',').map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean)
);

function isAdminEmail(email) {
  return ADMIN_EMAILS.has(String(email || '').toLowerCase());
}

module.exports = { isAdminEmail, ADMIN_EMAILS };
