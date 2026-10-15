import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tensionPerTurn, balancingPlan, turnsLabel } from '../src/build.js';
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
