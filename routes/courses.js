const router = require('express').Router();
const courses = require('../services/courses');
const requireAuth = require('../middleware/requireAuth');

// Gate: sign-in only — same as the Scoreboard picker on the capture page. We do
// NOT require an active subscription: course par/hcp/yardage is harmless public
// reference data, and gating it behind billing made the lookup fail (403) for
// logged-out or not-yet-comped testers. The capture screen calls these with raw
// fetch and degrades to manual entry on any failure, so nothing breaks offline.
router.use(requireAuth);

// GET /api/courses/status — lets the UI know whether lookup is available.
router.get('/status', (req, res) => {
  res.json({ configured: courses.isConfigured() });
});

// GET /api/courses/search?q=  — typeahead over the course database.
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  if (!courses.isConfigured()) {
    return res.status(503).json({ error: 'Course lookup is not configured', code: 'COURSE_API_UNCONFIGURED' });
  }
  try {
    res.json(await courses.searchCourses(q));
  } catch (e) {
    // The underlying message carries the vendor's status and body, which is the
    // only thing that distinguishes a revoked key from a rate limit from a bad
    // response for one particular query. It went to the server log only, so
    // every one of these looked identical from the capture screen. The caller is
    // signed in and the text contains no credentials.
    console.error('course search failed:', q, e.message);
    try { require('../services/errorLog').logError('courses/search', e, { userId: req.user && req.user.id }); } catch (_) {}
    res.status(502).json({ error: 'Course lookup failed', detail: e.message, query: q });
  }
});

// GET /api/courses/:id/tees — tees + per-hole par/hcp/yardage for a course.
router.get('/:id/tees', async (req, res) => {
  if (!courses.isConfigured()) {
    return res.status(503).json({ error: 'Course lookup is not configured', code: 'COURSE_API_UNCONFIGURED' });
  }
  try {
    const tees = await courses.getCourseTees(req.params.id);
    if (!tees || !tees.length) return res.status(404).json({ error: 'Course not found' });
    res.json(tees);
  } catch (e) {
    console.error('course tees failed:', req.params.id, e.message);
    try { require('../services/errorLog').logError('courses/tees', e, { userId: req.user && req.user.id }); } catch (_) {}
    res.status(502).json({ error: 'Course lookup failed', detail: e.message });
  }
});

module.exports = router;
