// Lightweight server-side error logging so the admin console can surface
// failures ("app/server errors that need to be addressed"). Best-effort:
// logging must never throw or mask the original error.
const { pool } = require('../db');

async function logError(source, err, meta = {}) {
  try {
    const message = err && err.message ? String(err.message).slice(0, 500)
                                       : String(err).slice(0, 500);
    const detail = err && err.stack ? String(err.stack).slice(0, 4000) : null;
    await pool.query(
      'INSERT INTO error_log (source, message, detail, user_id) VALUES ($1, $2, $3, $4)',
      [String(source).slice(0, 120), message, detail, meta.userId || null]
    );
  } catch (_) {
    // swallow — never let logging break a request
  }
}

module.exports = { logError };
