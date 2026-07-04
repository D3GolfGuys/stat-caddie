const router = require('express').Router();
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { seedDemo, clearDemo } = require('../services/demoSeed');

// Owner-only. Every route here requires a valid session AND the admin email.
router.use(requireAuth, requireAdmin);

// GET /api/admin/stats — platform-wide activity snapshot for the founder.
router.get('/stats', async (req, res) => {
  try {
    const [overview, byDay, users] = await Promise.all([
      pool.query(`SELECT
        (SELECT COUNT(*) FROM users)                                                    AS total_users,
        (SELECT COUNT(*) FROM rounds)                                                   AS total_rounds,
        (SELECT COUNT(DISTINCT user_id) FROM rounds)                                    AS active_users,
        (SELECT COUNT(*) FROM users  WHERE created_at > NOW() - INTERVAL '7 days')       AS signups_7d,
        (SELECT COUNT(*) FROM users  WHERE created_at > NOW() - INTERVAL '30 days')      AS signups_30d,
        (SELECT COUNT(*) FROM rounds WHERE created_at > NOW() - INTERVAL '7 days')       AS rounds_7d,
        (SELECT COUNT(*) FROM rounds WHERE created_at > NOW() - INTERVAL '30 days')      AS rounds_30d,
        (SELECT COUNT(DISTINCT user_id) FROM rounds WHERE created_at > NOW() - INTERVAL '7 days')  AS active_7d,
        (SELECT COUNT(DISTINCT user_id) FROM rounds WHERE created_at > NOW() - INTERVAL '30 days') AS active_30d
      `),
      pool.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
           FROM rounds
          WHERE created_at > NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.subscription_status,
                to_char(u.created_at, 'YYYY-MM-DD')      AS joined,
                COUNT(r.id)::int                          AS rounds,
                to_char(MAX(r.created_at), 'YYYY-MM-DD') AS last_round
           FROM users u
           LEFT JOIN rounds r ON r.user_id = u.id
          GROUP BY u.id
          ORDER BY u.created_at DESC`
      ),
    ]);
    res.json({ overview: overview.rows[0], roundsByDay: byDay.rows, users: users.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load admin stats' });
  }
});

// POST /api/admin/seed-demo — create/refresh 2 demo players with 5 rounds each
// so the all-players report view has data to show. Idempotent.
router.post('/seed-demo', async (req, res) => {
  try {
    const result = await seedDemo(pool);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to seed demo data' });
  }
});

// POST /api/admin/clear-demo — remove the demo players (and their rounds).
router.post('/clear-demo', async (req, res) => {
  try {
    const result = await clearDemo(pool);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear demo data' });
  }
});

module.exports = router;
