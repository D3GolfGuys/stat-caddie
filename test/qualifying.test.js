/**
 * Pure-logic tests for qualifying standings — no DB required.
 *   node test/qualifying.test.js
 */
const assert = require('assert');
const { computeStandings, normalizeConfig } = require('../services/qualifyingMath');

assert.deepStrictEqual(normalizeConfig(), { scoring: 'cumulative_to_par', countBest: null, dropWorst: 0 });
assert.deepStrictEqual(normalizeConfig('{"scoring":"average_to_par","dropWorst":1}'),
  { scoring: 'average_to_par', countBest: null, dropWorst: 1 });
assert.strictEqual(normalizeConfig({ scoring: 'bogus' }).scoring, 'cumulative_to_par');

let s = computeStandings([
  { userId: 1, name: 'A', toPars: [2, 3] },   // +5
  { userId: 2, name: 'B', toPars: [-1, 4] },  // +3
  { userId: 3, name: 'C', toPars: [] },       // unranked
], { scoring: 'cumulative_to_par' });
assert.strictEqual(s[0].userId, 2); assert.strictEqual(s[0].total, 3); assert.strictEqual(s[0].rank, 1);
assert.strictEqual(s[1].userId, 1); assert.strictEqual(s[1].total, 5); assert.strictEqual(s[1].rank, 2);
assert.strictEqual(s[2].userId, 3); assert.strictEqual(s[2].rank, null); assert.strictEqual(s[2].roundsPlayed, 0);

// drop-worst flips the order: without drop B(+7) beats A(+10); dropping each
// player's worst round leaves A(+2) ahead of B(+3).
s = computeStandings([
  { userId: 1, name: 'A', toPars: [2, 8] },
  { userId: 2, name: 'B', toPars: [3, 4] },
], { scoring: 'cumulative_to_par', dropWorst: 1 });
assert.strictEqual(s[0].userId, 1); assert.strictEqual(s[0].total, 2); assert.strictEqual(s[0].counted, 1);
assert.strictEqual(s[1].userId, 2); assert.strictEqual(s[1].total, 3);

s = computeStandings([{ userId: 1, name: 'A', toPars: [5, 1, 2] }], { countBest: 2 });
assert.strictEqual(s[0].total, 3); assert.strictEqual(s[0].counted, 2);

s = computeStandings([
  { userId: 1, name: 'A', toPars: [2, 4] },   // avg 3
  { userId: 2, name: 'B', toPars: [3, 3] },   // avg 3
], { scoring: 'average_to_par' });
assert.strictEqual(s[0].total, 3); assert.strictEqual(s[1].total, 3);
assert.strictEqual(s[0].rank, 1); assert.strictEqual(s[1].rank, 1);

console.log('OK  qualifying standings — all assertions passed');
