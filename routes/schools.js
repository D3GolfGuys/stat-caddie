const router = require('express').Router();
const { pool } = require('../db');
const { searchSchools } = require('../services/schools');

// GET /api/schools?q=&division=  — typeahead for the signup program picker.
router.get('/', async (req, res) => {
  try {
    const rows = await searchSchools(pool, {
      q: req.query.q || '', division: req.query.division || '', limit: req.query.limit || 20,
    });
    res.json({ schools: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search schools' });
  }
});

module.exports = router;
