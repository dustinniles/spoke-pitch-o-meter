import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beamModes, pinnedPinnedFreq, stringFreq, roundSection, MATERIALS, G,
  buildSpokeModel,
} from '../src/physics.js';

const steel = MATERIALS.steel;
const d = 2.0e-3;
const sec = roundSection(d);
const mu = sec.A * steel.rho;
const EI = steel.E * sec.Ithin;
const uniform = () => ({ mu, EI });

function rel(a, b) { return Math.abs(a - b) / Math.abs(b); }

// Clamped–clamped tensioned beam characteristic equation, solved by bisection.
function clampedClampedExact(L, T, mu, EI, n = 1) {
  const g = (w) => {
    const disc = Math.sqrt(T * T + 4 * EI * mu * w * w);
    const a = Math.sqrt((T + disc) / (2 * EI));
    const b = Math.sqrt((-T + disc) / (2 * EI));
    // Scaled by exp(-aL) to avoid overflow of cosh/sinh.
    const e = Math.exp(-a * L);
    const ch = (1 + e * e) / 2, sh = (1 - e * e) / 2;
    return 2 * a * b * (e - ch * Math.cos(b * L)) + (a * a - b * b) * sh * Math.sin(b * L);
  };
  // Scan for sign changes, return the n-th root.
  const wString = Math.PI / L * Math.sqrt(T / mu);
  let roots = [];
  let prevW = wString * 0.3, prevG = g(prevW);
  for (let w = prevW; w < wString * (n + 3) * 2 && roots.length < n; w += wString * 0.002) {
    const gw = g(w);
    if (Math.sign(gw) !== Math.sign(prevG)) {
      let lo = prevW, hi = w;
      for (let i = 0; i < 200; i++) {
        const m = (lo + hi) / 2;
        if (Math.sign(g(m)) === Math.sign(g(lo))) lo = m; else hi = m;
      }
      roots.push((lo + hi) / 2);
    }
    prevW = w; prevG = gw;
  }
  return roots[n - 1] / (2 * Math.PI);
}

test('pinned–pinned uniform beam matches the exact solution', () => {
  for (const [L, Tk] of [[0.2, 110], [0.15, 40], [0.28, 150]]) {
    const T = Tk * G;
    const f = beamModes({ L, T, props: uniform, nearEnd: 'pinned', farEnd: 'pinned', nModes: 3 });
    for (let n = 1; n <= 3; n++) {
      const exact = pinnedPinnedFreq(L, T, mu, EI, n);
      assert.ok(rel(f[n - 1], exact) < 2e-6, `L=${L} T=${Tk} n=${n}: ${f[n - 1]} vs ${exact}`);
    }
  }
});

test('clamped–clamped uniform beam matches the characteristic equation', () => {
  for (const [L, Tk] of [[0.2, 110], [0.15, 40], [0.26, 160]]) {
    const T = Tk * G;
    const f = beamModes({ L, T, props: uniform, nearEnd: 'clamped', farEnd: 'clamped', nModes: 2 });
    for (let n = 1; n <= 2; n++) {
      const exact = clampedClampedExact(L, T, mu, EI, n);
      assert.ok(rel(f[n - 1], exact) < 2e-6, `L=${L} T=${Tk} n=${n}: ${f[n - 1]} vs ${exact}`);
    }
  }
});

test('zero-tension limit recovers the clamped–clamped beam (βL = 4.7300)', () => {
  const L = 0.2;
  const f = beamModes({ L, T: 1e-6, props: uniform, nearEnd: 'clamped', farEnd: 'clamped', nModes: 1 })[0];
  const exact = (4.730040745 ** 2) / (2 * Math.PI * L * L) * Math.sqrt(EI / mu);
  assert.ok(rel(f, exact) < 1e-5, `${f} vs ${exact}`);
});

test('negligible stiffness recovers the ideal string', () => {
  const L = 0.2, T = 1000;
  const f = beamModes({ L, T, props: () => ({ mu, EI: 1e-9 }), nearEnd: 'pinned', farEnd: 'pinned', nModes: 1 })[0];
  assert.ok(rel(f, stringFreq(L, T, mu)) < 1e-6);
});

test('a clamped end acts like shortening the beam by √(EI/T)', () => {
  const L = 0.2, T = 110 * G;
  const f = beamModes({ L, T, props: uniform, nearEnd: 'clamped', farEnd: 'pinned', nModes: 1 })[0];
  const ell = Math.sqrt(EI / T);
  const approx = pinnedPinnedFreq(L - ell, T, mu, EI);
  assert.ok(rel(f, approx) < 0.003, `${f} vs ${approx}`);
});

test('spoke model inverts its own frequencies', () => {
  const spoke = { dThread: 2.0, dHead: 2.0, mid: { d: 1.8 }, threadButt: 25, headButt: 40, taper: 8 };
  const m = buildSpokeModel({ spoke, lengthMm: 190 });
  for (const tk of [40, 80, 120, 160, 220]) {
    const f = m.freqAt(tk * G);
    const back = m.tensionAt(f) / G;
    assert.ok(Math.abs(back - tk) < 0.05, `${tk} → ${f} Hz → ${back}`);
  }
});

test('an interior support splits the beam into continuous spans', () => {
  // Two equal pinned spans: the lowest mode is each span vibrating on its
  // own in opposite senses, exactly the single-span frequency.
  const T = 110 * G, L = 0.4;
  const f = beamModes({ L, T, props: uniform, nearEnd: 'pinned', farEnd: 'pinned', supports: [L / 2], nModes: 1 })[0];
  const exact = pinnedPinnedFreq(L / 2, T, mu, EI, 1);
  assert.ok(rel(f, exact) < 1e-5, `${f} vs ${exact}`);
});
