// Spoke vibration physics.
//
// A plucked spoke segment is modelled as a tensioned Euler–Bernoulli beam:
//   EI w'''' − T w'' + μ ẅ = 0
// with properties that vary along the length (butted ends, blade sections).
// The ideal-string formula T = 4 μ L² f² ignores bending stiffness, which
// raises the frequency most at low tension and near clamped ends. Solving the
// beam with finite elements removes that bias without empirical fudge factors.

export const G = 9.80665; // N per kgf

// Cold-drawn 18/8 stainless spring wire: 7.90–7.93 g/cm³; E falls from
// ~195 GPa to ~185 GPa with the cold work spokes receive.
export const MATERIALS = {
  steel: { name: 'Stainless steel', rho: 7920, E: 190e9 },
  titanium: { name: 'Titanium (6Al-4V)', rho: 4430, E: 114e9 },
  aluminum: { name: 'Aluminium (7075)', rho: 2810, E: 71.7e9 },
};

// --- Cross-section geometry ------------------------------------------------

// Round wire of diameter d (m).
export function roundSection(d) {
  const A = Math.PI * d * d / 4;
  const I = Math.PI * d ** 4 / 64;
  return { A, Ithin: I, Iwide: I };
}

// Bladed spoke modelled as a stadium (flat bar with round edges), width w and
// thickness t (m). "thin" bending = vibration across the flat face (the easy
// direction, what a sideways pluck excites). "wide" = vibration edge-on.
// Pass `area` instead of w to derive the width from the round wire the blade
// was forged from (forging keeps the cross-sectional area).
export function bladeSection(w, t, area = null) {
  if (area) w = t + Math.max(0, area - Math.PI * t * t / 4) / t;
  const flat = Math.max(w - t, 0);
  const A = flat * t + Math.PI * t * t / 4;
  const Ithin = flat * t ** 3 / 12 + Math.PI * t ** 4 / 64;
  const half = flat / 2;
  // Two semicircular edges approximated as a circle split about its centre line.
  const Iwide = t * flat ** 3 / 12 + Math.PI * t ** 4 / 64 + (Math.PI * t * t / 4) * half * half;
  return { A, Ithin, Iwide };
}

function lerp(a, b, u) { return a + (b - a) * u; }

function sectionLerp(s0, s1, u) {
  return { A: lerp(s0.A, s1.A, u), Ithin: lerp(s0.Ithin, s1.Ithin, u), Iwide: lerp(s0.Iwide, s1.Iwide, u) };
}

// Describe how the cross-section varies along the vibrating segment.
// x is measured from the nipple exit (m); L is the segment length (m).
// spoke fields (mm unless noted): dThread, dHead, mid: {d} or {w,t},
// threadButt (thick length beyond the nipple exit), headButt, taper.
// farEnd: 'cross' or 'hub'. Only a hub end brings the head butt into the segment.
export function makeProfile(spoke, L, farEnd) {
  const mm = 1e-3;
  const endSec = roundSection(spoke.dThread * mm);
  const headSec = roundSection((spoke.dHead ?? spoke.dThread) * mm);
  const midSec = spoke.mid.t
    ? bladeSection((spoke.mid.w ?? 0) * mm, spoke.mid.t * mm, spoke.mid.d0 ? Math.PI * (spoke.mid.d0 * mm) ** 2 / 4 : null)
    : roundSection(spoke.mid.d * mm);
  const taper = (spoke.taper ?? 8) * mm;
  const tb = (spoke.threadButt ?? 0) * mm;
  const hb = (spoke.headButt ?? 0) * mm;
  const mat = MATERIALS[spoke.material ?? 'steel'];
  // Real wire runs slightly heavier than its nominal size (see spokes.js).
  const massFactor = spoke.massFactor ?? 1;
  const mid = midSec;

  function sectionAt(x) {
    let s = mid;
    if (tb > 0 && x < tb + taper) {
      s = x <= tb ? endSec : sectionLerp(endSec, mid, (x - tb) / taper);
    }
    if (farEnd === 'hub' && hb > 0) {
      const y = L - x;
      if (y < hb + taper) {
        s = y <= hb ? headSec : sectionLerp(headSec, s, (y - hb) / taper);
      }
    }
    return s;
  }

  return {
    at(x, polarization = 'thin') {
      const s = sectionAt(x);
      return {
        mu: s.A * mat.rho * massFactor,
        EI: mat.E * (polarization === 'wide' ? s.Iwide : s.Ithin),
      };
    },
    material: mat,
  };
}

// --- Finite-element eigen solver --------------------------------------------

// Symmetric banded matrix, lower band stored row-wise: B[i*(bw+1)+k] = A[i][i-k].
function bandIndex(i, j, bw) { return i * (bw + 1) + (i - j); }

function bandedCholesky(B, n, bw) {
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - bw); j <= i; j++) {
      let s = B[bandIndex(i, j, bw)];
      for (let k = Math.max(0, i - bw, j - bw); k < j; k++) {
        s -= B[bandIndex(i, k, bw)] * B[bandIndex(j, k, bw)];
      }
      if (i === j) {
        if (s <= 0) throw new Error('Matrix not positive definite');
        B[bandIndex(i, i, bw)] = Math.sqrt(s);
      } else {
        B[bandIndex(i, j, bw)] = s / B[bandIndex(j, j, bw)];
      }
    }
  }
}

function bandedSolve(Lc, n, bw, b) {
  const y = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let s = y[i];
    for (let k = Math.max(0, i - bw); k < i; k++) s -= Lc[bandIndex(i, k, bw)] * y[k];
    y[i] = s / Lc[bandIndex(i, i, bw)];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) s -= Lc[bandIndex(k, i, bw)] * y[k];
    y[i] = s / Lc[bandIndex(i, i, bw)];
  }
  return y;
}

function bandedMul(B, n, bw, x) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - bw); j <= i; j++) {
      const v = B[bandIndex(i, j, bw)];
      y[i] += v * x[j];
      if (j !== i) y[j] += v * x[i];
    }
  }
  return y;
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// Assemble and solve. Returns natural frequencies in Hz (ascending).
// nearEnd/farEnd: 'clamped' or 'pinned'.
export function beamModes({ L, T, props, nearEnd = 'clamped', farEnd = 'pinned', nModes = 4, nElem = 80 }) {
  const nNodes = nElem + 1;
  const nFull = nNodes * 2;
  // Constrained DOFs.
  const fixed = new Set([0]);
  if (nearEnd === 'clamped') fixed.add(1);
  fixed.add(2 * nElem);
  if (farEnd === 'clamped') fixed.add(2 * nElem + 1);
  const map = new Int32Array(nFull).fill(-1);
  let n = 0;
  for (let d = 0; d < nFull; d++) if (!fixed.has(d)) map[d] = n++;
  const bw = 3;
  const K = new Float64Array(n * (bw + 1));
  const M = new Float64Array(n * (bw + 1));

  // Mesh graded towards both ends, where clamped boundary layers live.
  const xs = new Float64Array(nNodes);
  for (let i = 0; i < nNodes; i++) {
    const u = i / nElem;
    xs[i] = L * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI) * 0.6);
  }

  for (let e = 0; e < nElem; e++) {
    const h = xs[e + 1] - xs[e];
    const { mu, EI } = props((xs[e] + xs[e + 1]) / 2);
    const kb = EI / h ** 3;
    const kg = T / (30 * h);
    const mm = mu * h / 420;
    const h2 = h * h;
    const Ke = [
      [12 * kb + 36 * kg, 6 * h * kb + 3 * h * kg, -12 * kb - 36 * kg, 6 * h * kb + 3 * h * kg],
      [0, 4 * h2 * kb + 4 * h2 * kg, -6 * h * kb - 3 * h * kg, 2 * h2 * kb - h2 * kg],
      [0, 0, 12 * kb + 36 * kg, -6 * h * kb - 3 * h * kg],
      [0, 0, 0, 4 * h2 * kb + 4 * h2 * kg],
    ];
    const Me = [
      [156 * mm, 22 * h * mm, 54 * mm, -13 * h * mm],
      [0, 4 * h2 * mm, 13 * h * mm, -3 * h2 * mm],
      [0, 0, 156 * mm, -22 * h * mm],
      [0, 0, 0, 4 * h2 * mm],
    ];
    const dofs = [2 * e, 2 * e + 1, 2 * e + 2, 2 * e + 3];
    for (let a = 0; a < 4; a++) {
      for (let b = a; b < 4; b++) {
        const ia = map[dofs[a]], ib = map[dofs[b]];
        if (ia < 0 || ib < 0) continue;
        const i = Math.max(ia, ib), j = Math.min(ia, ib);
        K[bandIndex(i, j, bw)] += Ke[a][b];
        M[bandIndex(i, j, bw)] += Me[a][b];
      }
    }
  }

  const Lc = Float64Array.from(K);
  bandedCholesky(Lc, n, bw);

  // Inverse iteration with M-orthogonal deflation, one mode at a time.
  const modes = [];
  const freqs = [];
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  for (let m = 0; m < nModes; m++) {
    let x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = rand();
    let lambda = 0, prev = Infinity;
    for (let it = 0; it < 300; it++) {
      for (const v of modes) {
        const c = dot(v.Mv, x);
        for (let i = 0; i < n; i++) x[i] -= c * v.v[i];
      }
      const y = bandedSolve(Lc, n, bw, bandedMul(M, n, bw, x));
      for (const v of modes) {
        const c = dot(v.Mv, y);
        for (let i = 0; i < n; i++) y[i] -= c * v.v[i];
      }
      const My = bandedMul(M, n, bw, y);
      const Ky = bandedMul(K, n, bw, y);
      const yMy = dot(y, My);
      lambda = dot(y, Ky) / yMy;
      const norm = Math.sqrt(yMy);
      for (let i = 0; i < n; i++) y[i] /= norm;
      x = y;
      if (Math.abs(lambda - prev) < 1e-12 * lambda) break;
      prev = lambda;
    }
    const Mv = bandedMul(M, n, bw, x);
    modes.push({ v: x, Mv });
    freqs.push(Math.sqrt(lambda) / (2 * Math.PI));
  }
  return freqs;
}

// --- Closed forms used for testing and quick estimates ----------------------

export function stringFreq(L, T, mu, n = 1) {
  return n / (2 * L) * Math.sqrt(T / mu);
}

export function stringTension(L, f, mu) {
  return 4 * mu * L * L * f * f;
}

// Uniform tensioned beam, both ends pinned: exact.
export function pinnedPinnedFreq(L, T, mu, EI, n = 1) {
  const b = n * Math.PI / L;
  return Math.sqrt((EI * b ** 4 + T * b * b) / mu) / (2 * Math.PI);
}

// --- Spoke model: frequency ⇄ tension --------------------------------------

// Tension grid (N) used to tabulate f(T); spans slack-ish to over-tight.
const T_GRID_KGF = [];
for (let t = 10; t <= 320; t *= 1.06) T_GRID_KGF.push(t);

export function buildSpokeModel({ spoke, lengthMm, farEnd = 'cross', nearEnd = 'clamped', polarizations, nModes = 3, nElem = 70 }) {
  const L = lengthMm / 1000;
  const profile = makeProfile(spoke, L, farEnd);
  const farBC = farEnd === 'hub' ? 'clamped' : 'pinned';
  const pols = polarizations ?? (spoke.mid.t ? ['thin', 'wide'] : ['thin']);
  const tables = {};
  for (const pol of pols) {
    const props = (x) => profile.at(x, pol);
    const rows = T_GRID_KGF.map((tk) => {
      const f = beamModes({ L, T: tk * G, props, nearEnd, farEnd: farBC, nModes, nElem });
      return { T: tk * G, f };
    });
    tables[pol] = rows;
  }
  // Average mass per length along the segment, for the string comparison.
  let muSum = 0; const k = 200;
  for (let i = 0; i < k; i++) muSum += profile.at((i + 0.5) / k * L).mu;
  const muMean = muSum / k;
  return new SpokeModel({ L, tables, muMean, spoke, lengthMm, farEnd, nearEnd });
}

// Monotone interpolation in log–log space (f ∝ √T to first order).
function interpLogLog(xs, ys, x) {
  if (x <= xs[0]) {
    const s = Math.log(ys[1] / ys[0]) / Math.log(xs[1] / xs[0]);
    return ys[0] * Math.pow(x / xs[0], s);
  }
  const last = xs.length - 1;
  if (x >= xs[last]) {
    const s = Math.log(ys[last] / ys[last - 1]) / Math.log(xs[last] / xs[last - 1]);
    return ys[last] * Math.pow(x / xs[last], s);
  }
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  // Cubic Hermite in log space using finite-difference slopes.
  const lx = xs.map(Math.log), ly = ys.map(Math.log);
  const slope = (i) => {
    if (i <= 0) return (ly[1] - ly[0]) / (lx[1] - lx[0]);
    if (i >= last) return (ly[last] - ly[last - 1]) / (lx[last] - lx[last - 1]);
    return (ly[i + 1] - ly[i - 1]) / (lx[i + 1] - lx[i - 1]);
  };
  const h = lx[hi] - lx[lo];
  const u = (Math.log(x) - lx[lo]) / h;
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  return Math.exp(h00 * ly[lo] + h10 * h * slope(lo) + h01 * ly[hi] + h11 * h * slope(hi));
}

export class SpokeModel {
  constructor({ L, tables, muMean, spoke, lengthMm, farEnd, nearEnd }) {
    Object.assign(this, { L, tables, muMean, spoke, lengthMm, farEnd, nearEnd });
    this.polarizations = Object.keys(tables);
  }
  // Fundamental (mode index 0) or overtone frequency at tension T (N).
  freqAt(T, pol = 'thin', mode = 0) {
    const rows = this.tables[pol];
    return interpLogLog(rows.map((r) => r.T), rows.map((r) => r.f[mode]), T);
  }
  // Tension (N) that makes the given mode ring at f (Hz).
  tensionAt(f, pol = 'thin', mode = 0) {
    const rows = this.tables[pol];
    return interpLogLog(rows.map((r) => r.f[mode]), rows.map((r) => r.T), f);
  }
  // Overtone ratios f_n / f_1 at tension T (inharmonicity fingerprint).
  ratiosAt(T, pol = 'thin') {
    const f1 = this.freqAt(T, pol, 0);
    const n = this.tables[pol][0].f.length;
    const out = [];
    for (let m = 1; m < n; m++) out.push(this.freqAt(T, pol, m) / f1);
    return out;
  }
  // Ideal-string tension for comparison (what the original app computed).
  stringTension(f) {
    return stringTension(this.L, f, this.muMean);
  }
}
