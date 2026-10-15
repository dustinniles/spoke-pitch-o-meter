// Wheel-building helpers, after Jobst Brandt, The Bicycle Wheel (3rd ed.,
// Avocet): how much tension a nipple turn adds, and a balancing plan that
// evens tension on each side without moving the rim.
import { MATERIALS, bladeSection } from './physics.js';

// 56 threads per inch, standard on 1.8 and 2.0 mm spokes (Brandt: "about
// 0.45 mm pitch"). One nipple turn shortens the spoke by this much.
export const THREAD_PITCH_MM = 25.4 / 56;

// Turning one nipple stretches its spoke and pulls the rim in locally; the two
// act as springs in series. A measured full turn added about 43 kgf to a
// 2.0 mm spoke (US 5,103,414, 1992), which puts the rim's local stiffness near
// 1.75 MN/m. Deep or heavy rims are stiffer, so they gain a little more.
export const RIM_STIFFNESS = 1.75e6; // N/m

// Axial stiffness (N/m) of a whole spoke: its sections in series.
export function spokeAxialStiffness(spoke, spokeLenMm) {
  const mm = 1e-3;
  const E = MATERIALS[spoke.material ?? 'steel'].E;
  const mf = spoke.massFactor ?? 1;
  const round = (d) => Math.PI * (d * mm) ** 2 / 4 * mf;
  const midA = spoke.mid.t
    ? (spoke.mid.d0 ? round(spoke.mid.d0) : bladeSection(spoke.mid.w * mm, spoke.mid.t * mm).A * mf)
    : round(spoke.mid.d);
  const taper = spoke.taper ?? 8;
  // Thread end: about 12 mm inside the nipple plus the butt outside it.
  const threadLen = Math.min(spokeLenMm * 0.3, 12 + (spoke.threadButt ?? 0) + taper / 2);
  const headLen = Math.min(spokeLenMm * 0.3, (spoke.headButt ?? 0) + taper / 2);
  const midLen = Math.max(0, spokeLenMm - threadLen - headLen);
  const compliance = (threadLen * mm) / (E * round(spoke.dThread))
    + (headLen * mm) / (E * round(spoke.dHead ?? spoke.dThread))
    + (midLen * mm) / (E * midA);
  return 1 / compliance;
}

// Tension change (N) from one full nipple turn on a single spoke.
export function tensionPerTurn(spoke, spokeLenMm) {
  const k = spokeAxialStiffness(spoke, spokeLenMm);
  const keff = 1 / (1 / k + 1 / RIM_STIFFNESS);
  return keff * THREAD_PITCH_MM * 1e-3;
}

function medianOf(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// Brandt's balancing rule: "a spoke that is a half turn looser than its
// neighbors on the same side of the wheel should be tightened and its two
// neighbors should be loosened a quarter turn to keep alignment unchanged."
// Turns come in quarter steps, the finest adjustment he uses, and stay within
// one turn per round.
//   tensions: { hole: N } for the spokes measured on one side
//   neighbours(hole): the two same-side neighbours
//   gain: N per full turn
export function balancingPlan({ tensions, neighbours, gain, tolerance = 0.05, maxTurns = 1, joint = [] }) {
  const holes = Object.keys(tensions).map(Number);
  if (holes.length < 4 || !(gain > 0)) return { target: null, steps: [] };
  const target = medianOf(holes.map((h) => tensions[h]));
  // Round to quarter turns, but only take a step when it gets the spoke at
  // least ~60 % of the way there; a full quarter on a smaller gap overshoots.
  const quarter = (x) => Math.sign(x) * Math.floor(Math.abs(x) * 4 + 0.4) / 4;
  const towardZero = (x) => Math.sign(x) * Math.floor(Math.abs(x) * 4 + 1e-9) / 4;
  const byGap = [...holes].sort((a, b) => Math.abs(tensions[b] - target) - Math.abs(tensions[a] - target));
  const used = new Set();
  const steps = [];
  for (const h of byGap) {
    const dev = tensions[h] - target;
    if (Math.abs(dev) / target < tolerance) break;
    if (used.has(h)) continue;
    const turns = Math.max(-maxTurns, Math.min(maxTurns, quarter(-dev / gain)));
    if (turns === 0) continue;
    // Neighbours take half the opposite turn, unless they are already off the
    // same way: then the spoke sits in a loose or tight zone, and Brandt adjusts
    // only the odd spoke.
    const nTurns = towardZero(-turns / 2);
    const comp = [];
    let reason = null;
    if (nTurns === 0) reason = 'small';
    else {
      for (const n of neighbours(h)) {
        if (tensions[n] == null) continue;
        if (used.has(n)) { reason = reason ?? 'busy'; continue; }
        const nDev = (tensions[n] - target) / target;
        if (Math.sign(nDev) === Math.sign(dev) && Math.abs(nDev) > tolerance / 2) { reason = 'zone'; continue; }
        comp.push({ hole: n, turns: nTurns, T: tensions[n], predicted: tensions[n] + nTurns * gain });
      }
    }
    used.add(h);
    comp.forEach((c) => used.add(c.hole));
    steps.push({ hole: h, turns, dev: dev / target, T: tensions[h], predicted: tensions[h] + turns * gain, neighbours: comp, reason, nearJoint: joint.includes(h) });
  }
  return { target, steps };
}

// "¼", "½", "¾", "1¼" …
export function turnsLabel(t) {
  const a = Math.abs(t);
  const whole = Math.floor(a + 1e-9);
  const frac = Math.round((a - whole) * 4);
  const f = ['', '¼', '½', '¾'][frac];
  return `${whole ? whole : ''}${f}` || '0';
}
