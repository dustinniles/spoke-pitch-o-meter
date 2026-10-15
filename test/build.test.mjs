import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tensionPerTurn, balancingPlan, turnsLabel, expectedSideRatio, dishOffset, dishCorrection, nearestQuarter, spokeAxialStiffness } from '../src/build.js';
import { wheelGeometry } from '../src/geometry.js';
import { G } from '../src/physics.js';
import { spokeById } from '../src/spokes.js';

test('a full turn on a 2.0 mm spoke matches the measured ~43 kgf', () => {
  const g = tensionPerTurn(spokeById('dt-champion-20'), 290) / G;
  assert.ok(g > 38 && g < 48, `${g.toFixed(1)} kgf per turn`);
});

test('thinner butted spokes gain less per turn', () => {
  const champ = tensionPerTurn(spokeById('dt-champion-20'), 290);
  const comp = tensionPerTurn(spokeById('dt-competition'), 290);
  const rev = tensionPerTurn(spokeById('dt-revolution'), 290);
  assert.ok(champ > comp && comp > rev, `${champ} > ${comp} > ${rev}`);
});

// 16 spokes on one side, holes 1,3,…,31 of a 32-spoke wheel.
const side = Array.from({ length: 16 }, (_, i) => 2 * i + 1);
const neighbours = (h) => [((h - 3 + 32) % 32) + 1, ((h + 1) % 32) + 1];
const gain = 40 * G;

test('Brandt’s example: a spoke half a turn loose is tightened half a turn, its neighbours loosened a quarter', () => {
  const tensions = Object.fromEntries(side.map((h) => [h, 110 * G]));
  tensions[9] = 90 * G; // about half a turn low
  const plan = balancingPlan({ tensions, neighbours, gain });
  assert.equal(plan.steps.length, 1);
  const s = plan.steps[0];
  assert.equal(s.hole, 9);
  assert.equal(s.turns, 0.5);
  assert.deepEqual(s.neighbours.map((n) => [n.hole, n.turns]), [[7, -0.25], [11, -0.25]]);
});

test('a loose zone gets only the odd spoke adjusted, not its loose neighbours', () => {
  const tensions = Object.fromEntries(side.map((h) => [h, 110 * G]));
  tensions[9] = 88 * G; tensions[7] = 99 * G; tensions[11] = 100 * G;
  const plan = balancingPlan({ tensions, neighbours, gain });
  const s = plan.steps.find((x) => x.hole === 9);
  assert.ok(s && s.turns > 0);
  assert.equal(s.neighbours.length, 0);
});

test('an even wheel needs nothing', () => {
  const tensions = Object.fromEntries(side.map((h, i) => [h, (110 + (i % 3) - 1) * G]));
  assert.equal(balancingPlan({ tensions, neighbours, gain }).steps.length, 0);
});

test('turn labels', () => {
  assert.equal(turnsLabel(0.25), '¼');
  assert.equal(turnsLabel(-0.5), '½');
  assert.equal(turnsLabel(1), '1');
  assert.equal(turnsLabel(1.25), '1¼');
});

test('a gap smaller than most of a quarter turn is left alone', () => {
  const tensions = Object.fromEntries(side.map((h) => [h, 110 * G]));
  tensions[9] = 104 * G; // 6 kgf low; a quarter turn is 10 kgf here
  tensions[13] = 102 * G; // 8 kgf low: a quarter turn gets most of the way
  const plan = balancingPlan({ tensions, neighbours, gain });
  assert.deepEqual(plan.steps.map((st) => [st.hole, st.turns, st.reason]), [[13, 0.25, 'small']]);
});

// Shimano FH-R7000 (flange circles 44/45 mm, centre to flange 36.7/17.2 mm),
// 601 mm ERD, 32 spokes 3-cross.
const lenAt = (pcd) => (w) => wheelGeometry({ erd: 601, spokes: 32, crosses: 3, flangePcd: pcd, flangeOffset: w, nippleLen: 12 }).length;
const r7000 = { wL: 36.7, wR: 17.2, lenL: lenAt(44), lenR: lenAt(45) };

test('an 11-speed road rear hub puts the left side near half the right side’s tension', () => {
  const r = expectedSideRatio(r7000);
  assert.ok(r > 0.45 && r < 0.49, r.toFixed(3));
});

test('the tension ratio gives back the rim’s offset', () => {
  for (const d of [-1.5, 0, 1, 2.5]) {
    const ratio = expectedSideRatio({ ...r7000, d });
    assert.ok(Math.abs(dishOffset({ ratio, ...r7000 }) - d) < 0.01, `d ${d}`);
  }
  // Each millimetre toward the drive side costs about 4 points of ratio.
  const r0 = expectedSideRatio(r7000), r1 = expectedSideRatio({ ...r7000, d: 1 });
  assert.ok(r0 - r1 > 0.03 && r0 - r1 < 0.05, (r0 - r1).toFixed(3));
});

test('centring a rim pulled toward the drive side: tighten left, loosen right', () => {
  const k = spokeAxialStiffness(spokeById('dt-competition'), 293);
  const TR = 126 * G, d = 2.4;
  const TL = TR * expectedSideRatio({ ...r7000, d });
  const fix = dishCorrection({ d, TL, TR, ...r7000, kL: k, kR: k });
  assert.ok(fix.turnsL > 0.6 && fix.turnsL < 1.0, `left ${fix.turnsL.toFixed(2)}`);
  assert.ok(fix.turnsR < -0.15 && fix.turnsR > -0.4, `right ${fix.turnsR.toFixed(2)}`);
  assert.equal(nearestQuarter(fix.turnsL), 0.75);
  assert.equal(nearestQuarter(fix.turnsR), -0.25);
  // A centred rim at the same tensions needs nothing.
  const none = dishCorrection({ d: 0, TL: TR * expectedSideRatio(r7000), TR, ...r7000, kL: k, kR: k });
  assert.ok(Math.abs(none.turnsL) < 1e-9 && Math.abs(none.turnsR) < 1e-9);
});
