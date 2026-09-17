/**
 * Assistant-coach role tests — no DB, no network.
 *   node test/team-roles.test.js
 *
 * The pg pool is stubbed with a tiny SQL-dispatching fake so the real route
 * handlers, the real middleware and the real seat math all run. What's being
 * pinned down here is the business rule that's expensive to get wrong:
 *   • an assistant coach NEVER consumes a player seat (a team at cap can still
 *     add staff, and a team at cap still can't add a player);
 *   • an assistant sees every coach view but cannot touch roster/seats/settings.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');

// ── world ───────────────────────────────────────────────────────────────────
const TEAM = { id: 7, name: 'Demo University Golf', max_members: 15, division: 'D3' };
const USERS = {
  1: { id: 1, email: 'head@x.edu',  name: 'Head Coach',      role: 'team_admin',     team_id: 7, subscription_status: 'active',   subscription_plan: 'team' },
  2: { id: 2, email: 'asst@x.edu',  name: 'Assistant Coach', role: 'team_assistant', team_id: 7, subscription_status: 'inactive', subscription_plan: null },
  3: { id: 3, email: 'player@x.edu',name: 'Player One',      role: 'team_member',    team_id: 7, subscription_status: 'inactive', subscription_plan: null },
};
let PLAYER_COUNT = 15;          // team is AT CAP on players
let PENDING_PLAYER_INVITES = 0;
const INSERTED_INVITES = [];

// ── stubbed pg ──────────────────────────────────────────────────────────────
const rows = r => ({ rows: r, rowCount: r.length });
pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, ' ').trim();

  if (q.startsWith('SELECT id, email, name, role, team_id, subscription_status')) return rows([USERS[params[0]]].filter(Boolean));
  if (q.startsWith('SELECT * FROM teams WHERE id=$1')) return rows([TEAM]);
  if (q.startsWith('SELECT name FROM teams WHERE id=$1')) return rows([{ name: TEAM.name }]);
  if (q.startsWith('SELECT max_members FROM teams')) return rows([{ max_members: TEAM.max_members }]);
  if (q.startsWith('SELECT id, name, email, role, created_at FROM users')) return rows(Object.values(USERS));
  if (q.startsWith('SELECT COUNT(*) FROM users WHERE team_id=$1 AND role=$2')) {
    assert.strictEqual(params[1], 'team_member', 'seat count must count players only');
    return rows([{ count: String(PLAYER_COUNT) }]);
  }
  if (q.startsWith('SELECT COUNT(*) FROM invitations')) {
    assert.ok(q.includes("COALESCE(role,$2)=$2"), 'pending-invite seat count must be role-filtered');
    assert.strictEqual(params[1], 'team_member');
    return rows([{ count: String(PENDING_PLAYER_INVITES) }]);
  }
  if (q.startsWith('SELECT id FROM users WHERE email=$1')) return rows([]);           // not already a user
  if (q.startsWith('INSERT INTO invitations')) {
    assert.ok(q.includes('role'), 'invitation must persist the role');
    INSERTED_INVITES.push({ email: params[1], role: params[4] });
    if (params[4] === 'team_member') PENDING_PLAYER_INVITES += 1;
    return rows([]);
  }
  if (q.startsWith('SELECT r.id, u.id AS user_id')) return rows([{ id: 99, user_id: 3 }]);  // /rounds
  if (q.startsWith('SELECT r.tournament, r.round_num')) {                                    // /team-scores
    assert.ok(q.includes("u.role = 'team_member'"), 'team scoring counts players only');
    return rows([]);
  }
  if (q.startsWith('UPDATE teams SET')) return rows([{ max_members: TEAM.max_members + 1 }]);
  throw new Error('unstubbed query: ' + q.slice(0, 90));
};

// ── server ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/teams', require('../routes/teams'));
const server = http.createServer(app);

const as = id => 'token=' + jwt.sign({ userId: id }, process.env.JWT_SECRET);
async function call(method, path, userId, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: as(userId) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const HEAD = 1, ASST = 2, PLAYER = 3;

  // ── visibility: an assistant is a coach ───────────────────────────────────
  let r = await call('GET', '/api/teams/rounds', ASST);
  assert.strictEqual(r.status, 200, 'assistant can read team rounds');
  r = await call('GET', '/api/teams/team-scores', ASST);
  assert.strictEqual(r.status, 200, 'assistant can read team scoring history');
  r = await call('GET', '/api/teams/rounds', PLAYER);
  assert.strictEqual(r.status, 403, 'a player still cannot read the whole team');

  // ── /me reports the caller's own powers ──────────────────────────────────
  r = await call('GET', '/api/teams/me', HEAD);
  assert.deepStrictEqual(r.body.can, { manageRoster: true, manageSeats: true, manageTeam: true });
  r = await call('GET', '/api/teams/me', ASST);
  assert.deepStrictEqual(r.body.can, { manageRoster: false, manageSeats: false, manageTeam: false });
  assert.strictEqual(r.body.seats.players, 15, 'assistants are not counted as players');

  // ── roster / billing / settings stay with the head coach ─────────────────
  for (const [method, path, body] of [
    ['POST', '/api/teams/invite', { email: 'new@x.edu' }],
    ['POST', '/api/teams/seats', { addSeats: 1 }],
    ['PUT', '/api/teams/me', { name: 'Renamed' }],
    ['DELETE', '/api/teams/members/3', null],
  ]) {
    const res = await call(method, path, ASST, body);
    assert.strictEqual(res.status, 403, `assistant blocked from ${method} ${path}`);
    assert.strictEqual(res.body.code, 'HEAD_COACH_ONLY', `${path} explains who to ask`);
  }

  // ── the seat rule, at cap ────────────────────────────────────────────────
  r = await call('POST', '/api/teams/invite', HEAD, { email: 'player16@x.edu' });
  assert.strictEqual(r.status, 403, 'a 16th player needs a purchased seat');
  assert.strictEqual(r.body.code, 'SEATS_REQUIRED');

  r = await call('POST', '/api/teams/invite', HEAD, { email: 'asst2@x.edu', role: 'team_assistant' });
  assert.strictEqual(r.status, 200, 'an assistant invite goes through even at cap');
  assert.strictEqual(r.body.role, 'team_assistant');
  assert.deepStrictEqual(INSERTED_INVITES, [{ email: 'asst2@x.edu', role: 'team_assistant' }]);
  assert.strictEqual(r.body.seats.used, 15, 'the staff invite took no seat');

  // ── an unknown role can't be smuggled in ─────────────────────────────────
  PLAYER_COUNT = 1;
  r = await call('POST', '/api/teams/invite', HEAD, { email: 'sneaky@x.edu', role: 'team_admin' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(INSERTED_INVITES.pop().role, 'team_member', 'anything but team_assistant is a player');

  server.close();
  console.log('# OK  assistant coach role — all assertions passed');
})().catch(err => { console.error(err); server.close(); process.exit(1); });
