/**
 * Course catalog service
 * ----------------------
 * Thin wrapper over an external golf-course database (GolfCourseAPI by default)
 * that lets the capture screen pre-fill a hole's par / stroke-index (hcp) /
 * yardage, plus the tee's course rating & slope. Everything it returns is a
 * *suggestion* — the player can edit any field afterwards.
 *
 * Design notes
 *   • Fetched course cards are cached in our own `courses` / `course_tees`
 *     tables, so a venue is pulled from the vendor once and re-used for every
 *     round played there (keeps us well inside the free tier's daily quota).
 *   • No API key configured  → isConfigured() === false and the routes degrade
 *     to "lookup unavailable"; manual entry keeps working exactly as before.
 *   • Vendor is swappable: point GOLF_COURSE_API_URL / normalize* at another
 *     provider without touching the routes or the frontend.
 *
 * GolfCourseAPI reference (https://golfcourseapi.com):
 *   GET {BASE}/v1/search?search_query=<name>   → { courses: [ <course> ] }
 *   GET {BASE}/v1/courses/{id}                  → { course: <course> } | <course>
 *   Auth header:  Authorization: Key <API_KEY>
 * A <course> carries tees.male[] / tees.female[]; each tee has course_rating,
 * slope_rating, par_total, total_yards and holes[] of { par, handicap, yardage }.
 */
const { pool } = require('../db');

const SOURCE   = 'golfcourseapi';
const BASE_URL = (process.env.GOLF_COURSE_API_URL || 'https://api.golfcourseapi.com').replace(/\/+$/, '');
const API_KEY  = process.env.GOLF_COURSE_API_KEY || '';

function isConfigured() {
  return !!API_KEY;
}

// ── vendor call ──────────────────────────────────────────────────────────────
async function apiGet(path) {
  if (!isConfigured()) throw new Error('GOLF_COURSE_API_KEY not set');
  const res = await fetch(BASE_URL + path, {
    headers: { Authorization: 'Key ' + API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`course api ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Live health probe. Unlike searchCourses() this never throws and never
 * normalizes - it reports exactly what the vendor said, so a 401 (key revoked)
 * can be told apart from a 429 (quota) without reading server logs.
 */
async function probe(query = 'pebble') {
  if (!isConfigured()) return { configured: false, ok: false, reason: 'no_api_key' };
  const started = Date.now();
  try {
    const res = await fetch(BASE_URL + '/v1/search?search_query=' + encodeURIComponent(query), {
      headers: { Authorization: 'Key ' + API_KEY, Accept: 'application/json' },
    });
    const text = await res.text().catch(() => '');
    let count = null;
    try { count = (JSON.parse(text).courses || []).length; } catch (_) {}
    return {
      configured: true,
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      results: count,
      body: res.ok ? undefined : text.slice(0, 300),
      host: BASE_URL,
      query,
      keyTail: API_KEY.length > 4 ? '…' + API_KEY.slice(-4) : '(short)',
    };
  } catch (err) {
    return { configured: true, ok: false, reason: 'network', error: err.message, host: BASE_URL };
  }
}

// ── normalization ────────────────────────────────────────────────────────────
// The vendor is not consistent about shape: tees.male has been seen as an
// array, as an object keyed by tee name, and absent entirely; holes likewise.
// One oddly-shaped course used to throw and take down the whole search
// ("(t.male || []).forEach is not a function"), so coerce rather than assume.
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function locationText(loc) {
  if (!loc || typeof loc !== 'object') return null;
  return [loc.city, loc.state, loc.country].filter(Boolean).join(', ') || loc.address || null;
}

// Flatten one vendor tee into our shape. Hole numbers are 1-based by position.
function normalizeTee(tee, gender) {
  const holes = asArray(tee.holes).map((h, i) => ({
    hole: i + 1,
    par: h && h.par != null ? Number(h.par) : null,
    handicap: h && h.handicap != null ? Number(h.handicap) : null,
    yardage: h && h.yardage != null ? Number(h.yardage) : (h && h.yards != null ? Number(h.yards) : null),
  }));
  return {
    teeName: (tee && (tee.tee_name || tee.name)) || 'Tee',
    gender,
    parTotal: tee.par_total != null ? Number(tee.par_total) : null,
    yardageTotal: tee.total_yards != null ? Number(tee.total_yards) : null,
    courseRating: tee.course_rating != null ? Number(tee.course_rating) : null,
    slopeRating: tee.slope_rating != null ? Number(tee.slope_rating) : null,
    holes,
  };
}

// All tees for a course, men's then women's, richest (most holes) first.
function normalizeTees(course) {
  const t = (course && course.tees) || {};
  const out = [];
  // Some responses put every tee in one flat list with no gender split.
  if (Array.isArray(t)) {
    asArray(t).forEach((tee) => { if (tee) out.push(normalizeTee(tee, 'male')); });
  } else {
    asArray(t.male).forEach((tee) => { if (tee) out.push(normalizeTee(tee, 'male')); });
    asArray(t.female).forEach((tee) => { if (tee) out.push(normalizeTee(tee, 'female')); });
  }
  return out.filter((tee) => tee.holes.length > 0);
}

// ── cache ────────────────────────────────────────────────────────────────────
async function cacheCourse(course) {
  const externalId = String(course.id);
  const clubName   = course.club_name || null;
  const courseName = course.course_name || null;
  const location   = locationText(course.location);

  const { rows } = await pool.query(
    `INSERT INTO courses (source, external_id, club_name, course_name, location, raw, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, external_id) DO UPDATE SET
       club_name=$3, course_name=$4, location=$5, raw=$6, fetched_at=NOW()
     RETURNING id`,
    [SOURCE, externalId, clubName, courseName, location, JSON.stringify(course)]
  );
  const courseId = rows[0].id;

  const tees = normalizeTees(course);
  for (const tee of tees) {
    await pool.query(
      `INSERT INTO course_tees
         (course_id, tee_name, gender, par_total, yardage_total, course_rating, slope_rating, holes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (course_id, gender, tee_name) DO UPDATE SET
         par_total=$4, yardage_total=$5, course_rating=$6, slope_rating=$7, holes=$8`,
      [courseId, tee.teeName, tee.gender, tee.parTotal, tee.yardageTotal,
       tee.courseRating, tee.slopeRating, JSON.stringify(tee.holes)]
    );
  }
  return courseId;
}

// ── public API ───────────────────────────────────────────────────────────────

// Search the vendor by name. Caches every returned course card (they come with
// full tee data) and returns a lightweight list for the picker.
async function searchCourses(query) {
  const data = await apiGet('/v1/search?search_query=' + encodeURIComponent(query));
  const list = Array.isArray(data.courses) ? data.courses : (Array.isArray(data) ? data : []);
  const results = [];
  for (const course of list) {
    if (course && course.id != null) {
      try { await cacheCourse(course); } catch (e) { /* cache best-effort */ }
    }
    // A single malformed course must never fail the search; degrade that row
    // to zero tees and keep the rest of the results usable.
    let teeCount = 0;
    try { teeCount = normalizeTees(course).length; }
    catch (e) { console.warn('course', course && course.id, 'has unreadable tees:', e.message); }
    results.push({
      externalId: String(course.id),
      clubName: course.club_name || null,
      courseName: course.course_name || null,
      location: locationText(course.location),
      teeCount,
    });
  }
  return results;
}

// Tees for a course. Serves from cache when present, otherwise fetches by id.
async function getCourseTees(externalId) {
  const { rows } = await pool.query(
    `SELECT t.tee_name, t.gender, t.par_total, t.yardage_total,
            t.course_rating, t.slope_rating, t.holes
       FROM course_tees t
       JOIN courses c ON c.id = t.course_id
      WHERE c.source=$1 AND c.external_id=$2
      ORDER BY (t.gender='male') DESC, t.yardage_total DESC NULLS LAST`,
    [SOURCE, String(externalId)]
  );

  if (rows.length) {
    return rows.map((r) => ({
      teeName: r.tee_name,
      gender: r.gender,
      parTotal: r.par_total,
      yardageTotal: r.yardage_total,
      courseRating: r.course_rating != null ? Number(r.course_rating) : null,
      slopeRating: r.slope_rating,
      holes: r.holes || [],
    }));
  }

  // Not cached yet — fetch the single course and cache it.
  const data = await apiGet('/v1/courses/' + encodeURIComponent(externalId));
  const course = data.course || data;
  if (!course || course.id == null) return null;
  await cacheCourse(course);
  return normalizeTees(course);
}

module.exports = {
  probe, isConfigured, searchCourses, getCourseTees };
