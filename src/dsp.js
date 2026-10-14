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
  tail: 0.72,      // s of audio kept after onset, for tracking pitch glide
};

// --- Pitch glide ------------------------------------------------------------
//
// A pluck stretches the spoke a little, raising its tension and pitch while it
// swings hard; the pitch settles as the vibration dies away. For a string,
// Δf/f ≈ (3/32)·(EA/T)·(L/L_member)·(πA/L)² (Kirchhoff–Carrier), so the shift
// is proportional to amplitude squared. Track the peak through the decay in
// short frames and extrapolate frequency against amplitude² to zero.

export function glideFrames(x, fs, start, { win = 0.12, hop = 0.02 } = {}) {
  const n = Math.round(win * fs), h = Math.round(hop * fs);
  const w = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n); wsum += w[i]; }
  const frames = [];
  for (let s0 = start; s0 + n <= x.length; s0 += h) {
    const seg = new Float64Array(n);
    for (let i = 0; i < n; i++) seg[i] = x[s0 + i] * w[i];
    frames.push({ t: (s0 - start + n / 2) / fs, seg });
  }
  return { frames, fs, n, scale: 2 / wsum };
}

// Level (dB) of a windowed frame at one frequency: a single DTFT bin.
function dtftDb(seg, fs, f, scale) {
  const th = 2 * Math.PI * f / fs;
  const c = Math.cos(th), sn = Math.sin(th);
  let re = 0, im = 0, cr = 1, ci = 0;
  for (let i = 0; i < seg.length; i++) {
    re += seg[i] * cr; im -= seg[i] * ci;
    const t = cr * c - ci * sn; ci = cr * sn + ci * c; cr = t;
  }
  return 20 * Math.log10(Math.hypot(re, im) * scale + 1e-12);
}

// Fit f = f0 + c·a² over the frames where the peak near f is clear.
export function fitGlide(glide, f) {
  const { frames, fs, n, scale } = glide;
  // Quarter-bin grid across ±0.9 %: plenty for parabolic interpolation on a Hann lobe.
  const step = fs / n / 4;
  const kMax = Math.max(2, Math.ceil(f * 0.009 / step));
  const pts = [];
  for (const { t, seg } of frames) {
    const lv = [];
    for (let k = -kMax; k <= kMax; k++) lv.push(dtftDb(seg, fs, f + k * step, scale));
    let k = 0;
    for (let j = 1; j < lv.length; j++) if (lv[j] > lv[k]) k = j;
    if (k === 0 || k === lv.length - 1) continue; // no local maximum inside the window
    const a = lv[k - 1], b = lv[k], c = lv[k + 1];
    const den = a - 2 * b + c;
    const p = den ? 0.5 * (a - c) / den : 0;
    const level = b - 0.25 * (a - c) * p;
    // Prominence over the nearby spectrum (median of probes 2–5 % away, so a
    // neighbouring spoke's peak doesn't count as the floor).
    const probes = [0.95, 0.96, 0.97, 0.98, 1.02, 1.03, 1.04, 1.05].map((m) => dtftDb(seg, fs, f * m, scale)).sort((p, q) => p - q);
    const floor = (probes[3] + probes[4]) / 2;
    if (level - floor < 15) continue;
    pts.push({ t, f: f + (k - kMax + p) * step, level });
  }
  if (pts.length < 6) return null;
  const top = Math.max(...pts.map((q) => q.level));
  const use = pts.filter((q) => q.level > top - 35);
  if (use.length < 6) return null;
  // Weighted least squares; frequency noise variance scales as 1/a².
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const q of use) {
    const a2 = 10 ** ((q.level - top) / 10);
    const w = a2;
    sw += w; sx += w * a2; sy += w * q.f; sxx += w * a2 * a2; sxy += w * a2 * q.f;
  }
  const det = sw * sxx - sx * sx;
  const span = 10 ** ((top - Math.min(...use.map((q) => q.level))) / 10);
  if (det <= 0 || span < 4) return null; // need at least 6 dB of decay to see the trend
  const slope = (sw * sxy - sx * sy) / det;
  const f0 = (sy - slope * sx) / sw;
  let ss = 0;
  for (const q of use) { const a2 = 10 ** ((q.level - top) / 10); ss += a2 * (q.f - f0 - slope * a2) ** 2; }
  const rms = Math.sqrt(ss / sw);
  // Standard error of the slope from the weighted residuals.
  const seSlope = Math.sqrt((ss / Math.max(1, use.length - 2)) * sw / det);
  const shift = slope / f0; // fractional pitch rise at the loudest frame
  // Correct only for a clear, plausible downward glide; otherwise leave the
  // long-window frequency alone.
  const ok = slope > 3 * seSlope && shift > 0.0015 && shift < 0.05 && Math.abs(f0 / f - 1) < 0.04 && rms < 0.004 * f;
  return { f0: ok ? f0 : f, shift: ok ? shift : 0, rms, seShift: seSlope / f0, n: use.length, ok, points: use };
}

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

  // Correct the leading candidates for pitch glide.
  if (cands.length && x.length - a > fs * 0.3) {
    const frames = glideFrames(x, fs, a);
    for (const c of cands.slice(0, 3)) {
      const g = fitGlide(frames, c.f);
      c.fRaw = c.f;
      c.glide = g && g.ok ? g.shift : null;
      if (g && g.ok) {
        c.f = g.f0;
        if (model) c.T = model.tensionAt(c.f, c.pol ?? 'thin');
      }
    }
  }

  // Overtone cross-check: the 2nd and 3rd partials' ratios to the fundamental
  // give a second tension estimate that barely depends on how rigidly the
  // nipple and crossing hold the spoke (they shift every partial alike).
  if (model && cands.length) {
    for (const c of cands.slice(0, 3)) {
      const pol = c.pol ?? 'thin';
      const f1 = c.fRaw ?? c.f;
      const ratios = model.ratiosAt(c.T, pol);
      const est = [];
      ratios.forEach((r, i) => {
        const h = allPeaks.filter((q) => Math.abs(q.f / (f1 * r) - 1) < 0.012 && q.prom >= 10).sort((p, q) => q.level - p.level)[0];
        if (h) est.push({ mode: i + 2, T: model.tensionFromRatio(h.f / f1, i + 1, pol), level: h.level });
      });
      if (est.length) {
        // Prefer the stronger partial; the ratio is most sensitive for higher modes.
        est.sort((p, q) => q.level - p.level);
        c.overtone = { T: est[0].T, mode: est[0].mode, all: est };
      }
    }
  }

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
// `glide` on a partial is its fractional pitch rise at the moment of the pluck;
// it fades with amplitude² as the partial decays.
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
  for (const { f, amp, decay = 3, phase = 0, glide = 0 } of [...partials, ...extra]) {
    for (let i = p0; i < n; i++) {
      const t = (i - p0) / fs;
      const ph = 2 * Math.PI * f * (t + glide * (1 - Math.exp(-2 * decay * t)) / (2 * decay));
      x[i] += amp * Math.exp(-decay * t) * Math.sin(ph + phase);
    }
  }
  // Finger click: a few ms of broadband noise.
  for (let i = p0; i < p0 + Math.round(0.004 * fs); i++) x[i] += click * rand() * Math.exp(-(i - p0) / (0.001 * fs));
  return { x, onset: p0 };
}
