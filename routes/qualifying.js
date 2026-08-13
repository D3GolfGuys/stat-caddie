const router = require('express').Router();
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireSubscription = require('../middleware/requireSubscription');
const { requireTeamAdmin } = require('../middleware/requireSubscription');
const { isAdminEmail } = require('../services/admins');
const q = require('../services/qualifying');

router.use(requireAuth, requireSubscription);

// Ownership guard: the event must belong to the caller's team (or platform admin).
async function loadOwnEvent(req, res, next) {
  try {
    const ev = await q.getEvent(pool, req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (ev.team_id !== req.user.team_id && !isAdminEmail(req.user.email)) {
      return res.status(403).json({ error: 'Not your team\'s event' });
    }
    req.qualEvent = ev;
    next();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load event' }); }
}

// GET /api/qualifying — events for my team (coach dashboard + player list).
router.get('/', async (req, res) => {
  try {
    if (!req.user.team_id) return res.json({ events: [] });
    res.json({ events: await q.listEvents(pool, req.user.team_id) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load events' }); }
});

// GET /api/qualifying/open — open events a player can log a round to (capture screen).
router.get('/open', async (req, res) => {
  try {
    if (!req.user.team_id) return res.json({ events: [] });
    res.json({ events: await q.listOpenForTeam(pool, req.user.team_id) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load events' }); }
});

// POST /api/qualifying — coach creates an event.
router.post('/', requireTeamAdmin, async (req, res) => {
  try {
    if (!req.user.team_id) return res.status(400).json({ error: 'No team on account' });
    const { name, startsOn, endsOn, config } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    const ev = await q.createEvent(pool, {
      teamId: req.user.team_id, name: String(name).trim(),
      startsOn: startsOn || null, endsOn: endsOn || null, config: config || {},
    });
    res.status(201).json({ event: ev });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create event' }); }
});

// GET /api/qualifying/:id — event + live standings.
router.get('/:id', loadOwnEvent, async (req, res) => {
  try { res.json(await q.standings(pool, req.qualEvent.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load standings' }); }
});

// POST /api/qualifying/:id/status  { status: 'open' | 'closed' } — coach only.
router.post('/:id/status', requireTeamAdmin, loadOwnEvent, async (req, res) => {
  try {
    const status = req.body.status === 'closed' ? 'closed' : 'open';
    res.json({ event: await q.setStatus(pool, req.qualEvent.id, status) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update event' }); }
});

// POST /api/qualifying/:id/enroll  { userId? } — coach enrolls a player; a player may self-enroll.
router.post('/:id/enroll', loadOwnEvent, async (req, res) => {
  try {
    const targetId = Number(req.body.userId) || req.user.id;
    if (targetId !== req.user.id && req.user.role !== 'team_admin' && !isAdminEmail(req.user.email)) {
      return res.status(403).json({ error: 'Team admin required to enroll others' });
    }
    await q.enroll(pool, req.qualEvent.id, targetId);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to enroll' }); }
});

// POST /api/qualifying/:id/withdraw  { userId? }
router.post('/:id/withdraw', loadOwnEvent, async (req, res) => {
  try {
    const targetId = Number(req.body.userId) || req.user.id;
    if (targetId !== req.user.id && req.user.role !== 'team_admin' && !isAdminEmail(req.user.email)) {
      return res.status(403).json({ error: 'Team admin required' });
    }
    await q.withdraw(pool, req.qualEvent.id, targetId);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to withdraw' }); }
});

module.exports = router;
