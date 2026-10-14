// Signal processing: pluck detection, spectrum, and peak identification.

// --- FFT -------------------------------------------------------------------

const fftCache = new Map();

function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  t = { rev, cos, sin };
  fftCache.set(n, t);
  return t;
}

// In-place iterative radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// Magnitude spectrum in dB of a Hann-windowed, zero-padded segment.
export function spectrum(x, fs, { pad = 4, minSize = 0 } = {}) {
  const n = x.length;
  const N = Math.max(nextPow2(n * pad), minSize);
  const re = new Float64Array(N), im = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n);
    re[i] = x[i] * w; wsum += w;
  }
  fft(re, im);
  const bins = N / 2;
  const db = new Float32Array(bins);
  const scale = 2 / wsum;
  for (let k = 0; k < bins; k++) {
    const m = Math.hypot(re[k], im[k]) * scale;
    db[k] = 20 * Math.log10(m + 1e-12);
  }
  return { db, df: fs / N, fs, N, res: fs / n };
}

export function levelAt(spec, f) {
  const k = Math.round(f / spec.df);
  let best = -Infinity;
  for (let j = Math.max(0, k - 2); j <= Math.min(spec.db.length - 1, k + 2); j++) best = Math.max(best, spec.db[j]);
  return best;
}

// Local maxima with parabolic interpolation and prominence over a local median.
export function findPeaks(spec, fLo, fHi, { maxPeaks = 24, minProm = 6 } = {}) {
  const { db, df } = spec;
  const k0 = Math.max(2, Math.floor(fLo / df)), k1 = Math.min(db.length - 3, Math.ceil(fHi / df));
  const raw = [];
  for (let k = k0; k <= k1; k++) {
    if (db[k] > db[k - 1] && db[k] >= db[k + 1] && db[k] > db[k - 2] && db[k] >= db[k + 2]) {
      const a = db[k - 1], b = db[k], c = db[k + 1];
      const den = a - 2 * b + c;
      const p = den !== 0 ? 0.5 * (a - c) / den : 0;
      raw.push({ k, f: (k + p) * df, level: b - 0.25 * (a - c) * p });
    }
  }
  // Prominence: height above the median level within ±12 % in frequency.
  for (const pk of raw) {
    const lo = Math.max(1, Math.floor(pk.f * 0.88 / df)), hi = Math.min(db.length - 1, Math.ceil(pk.f * 1.12 / df));
    const stride = Math.max(1, Math.floor((hi - lo) / 200));
    const vals = [];
    for (let k = lo; k <= hi; k += stride) vals.push(db[k]);
    vals.sort((p, q) => p - q);
    pk.prom = pk.level - vals[vals.length >> 1];
  }
  // Keep the strongest. Drop shoulders within 0.6 % of a stronger peak, and
  // window sidelobes: weak peaks within a few resolution bins of a much
  // stronger one (Hann sidelobes sit 31 dB down and fall off from there).
  raw.sort((p, q) => q.level - p.level);
  const res = spec.res ?? df;
  const out = [];
  for (const pk of raw) {
    if (pk.prom < minProm) continue;
    if (out.some((o) => Math.abs(o.f - pk.f) / o.f < 0.006)) continue;
    if (out.some((o) => {
      const d = Math.abs(o.f - pk.f), drop = o.level - pk.level;
      return (d < 4 * res && drop > 20) || (d < 10 * res && drop > 30);
    })) continue;
    out.push(pk);
    if (out.length >= maxPeaks) break;
  }
  return out;
}

// --- Pluck detector (streaming) ---------------------------------------------

// Watches incoming audio for the sharp rise of a pluck above the room's noise
// floor. A first-order high-pass removes handling rumble and HVAC noise.
export class PluckDetector {
  constructor(fs, { sensitivityDb = 18, hop = 256, refractory = 0.35 } = {}) {
    this.fs = fs;
    this.hop = hop;
    this.sensitivityDb = sensitivityDb;
    this.refractory = Math.round(refractory * fs);
    const rc = 1 / (2 * Math.PI * 150);
    this.hpA = rc / (rc + 1 / fs);
    this.prevX = 0; this.prevY = 0;
    this.acc = 0; this.count = 0;
    this.floorDb = -70;
    this.history = [];
    this.sample = 0;
    this.lastOnset = -Infinity;
    this.levelDb = -120;
    // Ignore the first moments while the noise floor settles.
    this.warmup = Math.round(0.3 * fs);
  }
  // Feed a block; returns sample indices (stream time) where plucks begin.
  push(block) {
    const onsets = [];
    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      const y = this.hpA * (this.prevY + x - this.prevX);
      this.prevX = x; this.prevY = y;
      this.acc += y * y; this.count++;
      if (this.count === this.hop) {
        const e = 10 * Math.log10(this.acc / this.hop + 1e-14);
        this.levelDb = e;
        const t = this.sample + i;
        const recent = this.history.length ? Math.max(...this.history) : e;
        const rising = e - recent > 9;
        const loud = e - this.floorDb > this.sensitivityDb;
        if (rising && loud && t > this.warmup && t - this.lastOnset > this.refractory) {
          // Back up to the start of this hop.
          onsets.push(t - this.hop);
          this.lastOnset = t;
        }
        // Noise floor: fall fast, rise slowly, ignore loud events.
        if (e < this.floorDb) this.floorDb = 0.7 * this.floorDb + 0.3 * e;
        else if (e - this.floorDb < 10) this.floorDb += 0.02 * (e - this.floorDb);
        else this.floorDb += 0.002;
        this.history.push(e);
        if (this.history.length > 4) this.history.shift();
        this.acc = 0; this.count = 0;
      }
    }
    this.sample += block.length;
    return onsets;
  }
}

// --- Pluck analysis -----------------------------------------------------------

export const ANALYSIS = {
  skip: 0.010,     // s after onset to skip the finger click
  window: 0.40,    // s analysed for the main spectrum
  lateStart: 0.16, // s after onset for the sustain check
  lateWindow: 0.24,
  pre: 0.12,       // s of pre-onset audio used as the background reference
};

// Analyse one pluck. `x` holds audio starting `preSamples` before the onset.
// `model` (SpokeModel) turns frequencies into tensions and predicts overtones.
// `expectedT` (N) optionally nudges ambiguous picks toward the wheel's level.
export function analyzePluck(x, fs, { model = null, preSamples = 0, expectedT = null, tMinKgf = 15, tMaxKgf = 320 } = {}) {
  const G = 9.80665;
  const a = preSamples + Math.round(ANALYSIS.skip * fs);
  const mainLen = Math.min(Math.round(ANALYSIS.window * fs), x.length - a);
  if (mainLen < fs * 0.08) return null;
  const main = spectrum(x.subarray(a, a + mainLen), fs, { pad: 4, minSize: 32768 });
  const ls = preSamples + Math.round(ANALYSIS.lateStart * fs);
  const lateLen = Math.min(Math.round(ANALYSIS.lateWindow * fs), x.length - ls);
  const late = lateLen > fs * 0.06 ? spectrum(x.subarray(ls, ls + lateLen), fs, { pad: 2, minSize: main.N }) : null;
  const bgLen = Math.min(preSamples, Math.round(ANALYSIS.pre * fs));
  const bg = bgLen > fs * 0.03 ? spectrum(x.subarray(preSamples - bgLen, preSamples), fs, { pad: 1, minSize: main.N }) : null;

  // Search band: the fundamental's range for plausible tensions.
  let fLo = 120, fHi = 2500;
  const pols = model ? model.polarizations : [];
  if (model) {
    fLo = Math.min(...pols.map((p) => model.freqAt(tMinKgf * G, p))) * 0.97;
    fHi = Math.max(...pols.map((p) => model.freqAt(tMaxKgf * G, p))) * 1.03;
  }
  const allPeaks = findPeaks(main, 80, Math.min(fs / 2 - 200, 6000), { maxPeaks: 60, minProm: 5 });
  // Candidates: in the band and within 35 dB of the strongest peak.
  const top0 = allPeaks.length ? Math.max(...allPeaks.map((p) => p.level)) : -120;
  const inBand = allPeaks.filter((p) => p.f >= fLo && p.f <= fHi && p.level > top0 - 35);
  const near = (f, tol) => allPeaks.find((p) => Math.abs(p.f - f) / f < tol);

  const topLevel = top0;
  const cands = inBand.map((p) => {
    const c = { f: p.f, level: p.level, prom: p.prom, score: 0, notes: [] };
    // Loudness relative to the strongest peak, and above the room background.
    c.rel = p.level - topLevel;
    c.snr = bg ? p.level - levelAt(bg, p.f) : 30;
    // Sustain: a ringing spoke mode is still present 160 ms later.
    if (late) {
      const lateLvl = levelAt(late, p.f);
      const lateFloor = late.db[Math.round(p.f * 1.07 / late.df)] ?? -120;
      c.sustain = lateLvl - Math.max(lateFloor, levelAt(late, p.f * 0.93));
    } else c.sustain = 0;
    if (model) {
      c.T = model.tensionAt(p.f, 'thin');
      c.pol = 'thin';
      // Overtone fingerprint: the stiff spoke's partials sit slightly sharp of
      // whole-number multiples. Matching them confirms the fundamental.
      const ratios = model.ratiosAt(c.T, 'thin');
      let harm = 0, found = 0;
      ratios.forEach((r) => {
        const h = near(p.f * r, 0.012);
        if (h) { found++; harm += Math.min(h.prom, 25) * 0.5; }
      });
      c.harmonics = found;
      // If this peak is itself an overtone of a lower candidate, demote it.
      const r2 = ratios[0];
      const lower = inBand.find((q) => Math.abs(q.f * r2 - p.f) / p.f < 0.012 && q.level > p.level - 18);
      if (lower) { c.score -= 12; c.notes.push('overtone of lower peak'); }
      // Bladed spokes ring in two planes; the sideways (thin) mode is the lower one.
      if (pols.includes('wide')) {
        const split = model.freqAt(c.T, 'wide') / p.f;
        const partner = inBand.find((q) => q !== p && Math.abs(q.f / p.f - split) < 0.004);
        if (partner) { c.score += 4; c.notes.push('edge-on twin found'); }
        const partnerBelow = inBand.find((q) => q !== p && Math.abs(p.f / q.f - split) < 0.004 && q.level > p.level - 12);
        if (partnerBelow) { c.score -= 8; c.pol = 'wide'; c.notes.push('edge-on mode'); }
      }
      c.score += harm;
      if (expectedT) c.score -= 14 * Math.abs(Math.log(c.T / expectedT));
    }
    c.score += Math.min(c.prom, 40) + 0.6 * Math.max(-30, c.rel) + 0.5 * Math.min(Math.max(c.sustain, -10), 25) + 0.3 * Math.min(c.snr, 40);
    return c;
  });
  cands.sort((p, q) => q.score - p.score);

  const best = cands[0] ?? null;
  let confidence = 0;
  if (best) {
    const margin = cands[1] ? best.score - cands[1].score : 30;
    const clean = Math.min(1, Math.max(0, (best.snr - 8) / 20));
    confidence = Math.max(0, Math.min(1, (1 - Math.exp(-margin / 10)) * clean));
  }
  return { spec: main, late, bg, peaks: allPeaks, candidates: cands, best, confidence, band: [fLo, fHi], fs };
}

// --- Synthetic pluck (tests and the in-app demo) ----------------------------

// Sum of damped partials plus optional interfering modes, click and noise.
export function synthPluck({ fs = 48000, dur = 0.8, partials, extra = [], noise = 0.0015, click = 0.3, pre = 0.15, seed = 7, hum = 0 }) {
  const n = Math.round((dur + pre) * fs);
  const x = new Float32Array(n);
  let s = seed;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const p0 = Math.round(pre * fs);
  for (let i = 0; i < n; i++) {
    x[i] = noise * rand() * 2;
    if (hum) x[i] += hum * (Math.sin(2 * Math.PI * 60 * i / fs) + 0.5 * Math.sin(2 * Math.PI * 180 * i / fs));
  }
  for (const { f, amp, decay = 3, phase = 0 } of [...partials, ...extra]) {
    for (let i = p0; i < n; i++) {
      const t = (i - p0) / fs;
      x[i] += amp * Math.exp(-decay * t) * Math.sin(2 * Math.PI * f * t + phase);
    }
  }
  // Finger click: a few ms of broadband noise.
  for (let i = p0; i < p0 + Math.round(0.004 * fs); i++) x[i] += click * rand() * Math.exp(-(i - p0) / (0.001 * fs));
  return { x, onset: p0 };
}
