/**
 * Schools reference — find-or-create + typeahead search.
 * Programs are created organically as coaches sign up (name + division +
 * conference), growing the `schools` table into a program directory. Clippd
 * id stays null for user-entered schools (populated later if matched to the
 * catalog). `db` may be a pool or a client, so it can run inside a txn.
 */
const norm = s => String(s || '').trim();

async function findOrCreateSchool(db, x) {
  const name = norm(x.name);
  if (!name) return null;
  const division = norm(x.division) || null;
  const conference = norm(x.conference) || null;
  const region = norm(x.region) || null;
  const gender = norm(x.gender) || null;

  const found = await db.query(
    `SELECT id FROM schools
     WHERE lower(name) = lower($1) AND division IS NOT DISTINCT FROM $2
     LIMIT 1`, [name, division]);
  if (found.rows.length) {
    const id = found.rows[0].id;
    await db.query(
      `UPDATE schools SET
         conference = COALESCE(conference, $2),
         region     = COALESCE(region, $3),
         gender     = COALESCE(gender, $4)
       WHERE id = $1`, [id, conference, region, gender]);
    return id;
  }
  const ins = await db.query(
    `INSERT INTO schools (name, division, conference, region, gender)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name, division, conference, region, gender]);
  return ins.rows[0].id;
}

async function searchSchools(db, { q = '', division = '', limit = 20 } = {}) {
  const params = [], where = ['name IS NOT NULL'];
  if (norm(q))        { params.push(`%${norm(q)}%`); where.push(`name ILIKE $${params.length}`); }
  if (norm(division)) { params.push(norm(division)); where.push(`division = $${params.length}`); }
  params.push(Math.min(Number(limit) || 20, 50));
  const { rows } = await db.query(
    `SELECT id, name, division, conference, region
       FROM schools WHERE ${where.join(' AND ')}
      ORDER BY name ASC LIMIT $${params.length}`, params);
  return rows;
}

module.exports = { findOrCreateSchool, searchSchools };
