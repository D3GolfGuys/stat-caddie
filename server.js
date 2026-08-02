require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initDB } = require('./db');

const app = express();

// ── Raw body for Stripe webhooks (must come before json middleware) ──
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));

// ── General middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Rate limiting ────────────────────────────────────────────────────
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many requests, please try again later.' } }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 120 }));

// ── Static files ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ───────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/rounds',        require('./routes/rounds'));
app.use('/api/courses',       require('./routes/courses'));
app.use('/api/schools',       require('./routes/schools'));
app.use('/api/rankings',      require('./routes/rankings'));
app.use('/api/teams',         require('./routes/teams'));
app.use('/api/scoreboard',    require('./routes/scoreboard'));
app.use('/api/admin',         require('./routes/admin'));

// ── Health check ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Public config (lets the frontend know if billing is bypassed) ────
app.get('/api/config', (req, res) => res.json({ betaMode: process.env.BETA_MODE === 'true' }));

// ── SPA fallback — serve index.html for unknown routes ───────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`⛳ College Golf Metrics running on http://localhost:${PORT}`));
  // Nightly rankings recompute (in-process scheduler; disable with RANKINGS_AUTO=false)
  if (process.env.RANKINGS_AUTO !== 'false') {
    const rankings = require('./services/rankings');
    const { pool } = require('./db');
    const run = () => rankings.recompute(pool, { seasonLabel: process.env.SEASON_LABEL || 'current' })
      .then(s => console.log('🔁 Rankings recomputed:', s))
      .catch(e => console.error('Rankings recompute failed:', e.message));
    setTimeout(run, 30000);                       // once shortly after boot
    setInterval(run, 24 * 60 * 60 * 1000);        // then daily
  }
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
