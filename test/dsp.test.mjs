import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fft, spectrum, findPeaks, PluckDetector, analyzePluck, synthPluck } from '../src/dsp.js';
import { buildSpokeModel, G } from '../src/physics.js';

const fs = 48000;

test('FFT matches a direct DFT', () => {
  const n = 64;
  const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9) + (i % 5) * 0.01);
  const re = Float64Array.from(x), im = new Float64Array(n);
  fft(re, im);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let i = 0; i < n; i++) { sr += x[i] * Math.cos(-2 * Math.PI * k * i / n); si += x[i] * Math.sin(-2 * Math.PI * k * i / n); }
    assert.ok(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9);
  }
});

test('peak frequency of a decaying tone is accurate to a few hundredths of a hertz', () => {
  for (const f0 of [312.77, 523.37, 911.05]) {
    const { x, onset } = synthPluck({ fs, partials: [{ f: f0, amp: 0.3, decay: 4 }], noise: 0.001, click: 0 });
    const seg = x.subarray(onset + 480, onset + 480 + 19200);
    const sp = spectrum(seg, fs, { pad: 4, minSize: 32768 });
    const pk = findPeaks(sp, f0 * 0.9, f0 * 1.1)[0];
    assert.ok(Math.abs(pk.f - f0) < 0.05, `${f0}: got ${pk.f}`);
  }
});

test('pluck detector fires once per pluck and stays quiet on room noise', () => {
  const det = new PluckDetector(fs);
  // Two seconds of noise, then a pluck, then noise, then another pluck.
  const quiet = synthPluck({ fs, dur: 2, partials: [], click: 0, noise: 0.003, pre: 0 }).x;
  const p1 = synthPluck({ fs, dur: 1, partials: [{ f: 480, amp: 0.2 }], noise: 0.003, pre: 0.1, seed: 3 }).x;
  const p2 = synthPluck({ fs, dur: 1, partials: [{ f: 505, amp: 0.05 }], noise: 0.003, pre: 0.1, seed: 9 }).x;
  const stream = new Float32Array(quiet.length + p1.length + p2.length);
  stream.set(quiet); stream.set(p1, quiet.length); stream.set(p2, quiet.length + p1.length);
  const onsets = [];
  for (let i = 0; i < stream.length; i += 128) onsets.push(...det.push(stream.subarray(i, i + 128)));
  assert.equal(onsets.length, 2, `onsets at ${onsets}`);
  const expect1 = quiet.length + 0.1 * fs, expect2 = quiet.length + p1.length + 0.1 * fs;
  assert.ok(Math.abs(onsets[0] - expect1) < 600, `${onsets[0]} vs ${expect1}`);
  assert.ok(Math.abs(onsets[1] - expect2) < 600, `${onsets[1]} vs ${expect2}`);
});

// A butted 2.0/1.8/2.0 spoke, 195 mm from nipple to cross.
const spoke = { dThread: 2.0, dHead: 2.0, mid: { d: 1.8 }, threadButt: 22, headButt: 40, taper: 8 };
const model = buildSpokeModel({ spoke, lengthMm: 195 });

function pluckAt(tKgf, { extra = [], noise = 0.0015, hum = 0, seed = 7 } = {}) {
  const T = tKgf * G;
  const f1 = model.freqAt(T);
  const r = model.ratiosAt(T);
  const partials = [
    { f: f1, amp: 0.25, decay: 3 },
    { f: f1 * r[0], amp: 0.08, decay: 5 },
    { f: f1 * r[1], amp: 0.05, decay: 7 },
  ];
  const pre = 0.15;
  const { x } = synthPluck({ fs, partials, extra: extra.map((e) => ({ ...e, f: e.ratio * f1 })), noise, hum, pre, seed });
  return { x, pre: Math.round(pre * fs), f1 };
}

test('recovers the tension of a clean pluck within 0.2 %', () => {
  for (const tk of [55, 90, 120, 150]) {
    const { x, pre } = pluckAt(tk);
    const r = analyzePluck(x, fs, { model, preSamples: pre });
    const got = r.best.T / G;
    assert.ok(Math.abs(got - tk) / tk < 0.002, `${tk}: got ${got.toFixed(2)}`);
    assert.ok(r.confidence > 0.5, `confidence ${r.confidence}`);
  }
});

test('ignores weaker crossing-spoke and pair modes (Wilson’s 65 / 104 / 113 kgf case)', () => {
  // Interferers at the frequency ratios implied by Wilson's peaks.
  const extra = [
    { ratio: Math.sqrt(65 / 113), amp: 0.12, decay: 4 },
    { ratio: Math.sqrt(104 / 113), amp: 0.15, decay: 3 },
  ];
  const { x, pre } = pluckAt(113, { extra, hum: 0.01 });
  const r = analyzePluck(x, fs, { model, preSamples: pre });
  const got = r.best.T / G;
  assert.ok(Math.abs(got - 113) < 0.5, `got ${got.toFixed(1)}; candidates ${r.candidates.map((c) => (c.T / G).toFixed(0) + ':' + c.score.toFixed(0)).join(' ')}`);
});

test('an equally loud neighbouring spoke is flagged as low confidence', () => {
  // The interferer is a whole second spoke at 104 kgf, overtones included.
  const k = Math.sqrt(104 / 113);
  const r = model.ratiosAt(104 * G);
  const extra = [
    { ratio: k, amp: 0.25, decay: 3 },
    { ratio: k * r[0], amp: 0.08, decay: 5 },
    { ratio: k * r[1], amp: 0.05, decay: 7 },
  ];
  const { x, pre } = pluckAt(113, { extra });
  const res = analyzePluck(x, fs, { model, preSamples: pre });
  assert.ok(res.confidence < 0.6, `confidence ${res.confidence.toFixed(2)}`);
  assert.ok(res.candidates.length >= 2);
});

test('a strong second partial is not mistaken for the fundamental', () => {
  const T = 100 * G;
  const f1 = model.freqAt(T);
  const r2 = model.ratiosAt(T)[0];
  const { x } = synthPluck({ fs, partials: [{ f: f1, amp: 0.1, decay: 3 }, { f: f1 * r2, amp: 0.25, decay: 4 }], pre: 0.15 });
  const r = analyzePluck(x, fs, { model, preSamples: Math.round(0.15 * fs) });
  assert.ok(Math.abs(r.best.T / G - 100) < 0.5, `got ${(r.best.T / G).toFixed(1)}`);
});

function gliding(tKgf, glide, { decay = 3, extra = [], seed = 11 } = {}) {
  const T = tKgf * G, f1 = model.freqAt(T), r = model.ratiosAt(T);
  const pre = 0.15;
  const { x } = synthPluck({
    fs, dur: 0.9, pre, seed, noise: 0.0015,
    partials: [{ f: f1, amp: 0.25, decay, glide }, { f: f1 * r[0], amp: 0.08, decay: decay * 1.6, glide: glide * 4 }, { f: f1 * r[1], amp: 0.04, decay: decay * 2.3 }],
    extra: extra.map((e) => ({ ...e, f: e.ratio * f1 })),
  });
  return analyzePluck(x, fs, { model, preSamples: Math.round(pre * fs) });
}

test('a hard pluck’s pitch glide is removed by extrapolating to zero amplitude', () => {
  for (const [glide, decay] of [[0.008, 3], [0.015, 3], [0.015, 1.8], [0.025, 4]]) {
    const r = gliding(110, glide, { decay });
    const raw = model.tensionAt(r.best.fRaw) / G;
    const got = r.best.T / G;
    assert.ok(raw > 110 * 1.003, `uncorrected reading should be high (${raw.toFixed(1)})`);
    assert.ok(Math.abs(got - 110) < 0.5, `glide ${glide}, decay ${decay}: corrected ${got.toFixed(2)} (raw ${raw.toFixed(1)})`);
  }
});

test('a gentle pluck is left alone', () => {
  const r = gliding(110, 0);
  assert.ok(Math.abs(r.best.T / G - 110) < 0.25, `got ${(r.best.T / G).toFixed(2)}`);
});

test('glide correction survives a weaker crossing-spoke mode 4 % below', () => {
  const r = gliding(113, 0.015, { extra: [{ ratio: Math.sqrt(104 / 113), amp: 0.1, decay: 3 }] });
  assert.ok(Math.abs(r.best.T / G - 113) < 0.8, `got ${(r.best.T / G).toFixed(2)}`);
});

test('two modes 0.4 % apart are split instead of averaged', () => {
  const T = 110 * G, f1 = model.freqAt(T), r = model.ratiosAt(T);
  const pre = 0.15;
  const { x } = synthPluck({ fs, dur: 0.8, pre, seed: 4, partials: [
    { f: f1, amp: 0.25, decay: 3 }, { f: f1 * 1.004, amp: 0.15, decay: 3.2 },
    { f: f1 * r[0], amp: 0.06, decay: 5 }, { f: f1 * r[1], amp: 0.04, decay: 7 }] });
  const res = analyzePluck(x, fs, { model, preSamples: Math.round(pre * fs) });
  const fftT = model.tensionAt(res.best.fFft) / G;
  assert.ok(res.best.doublet, 'doublet detected');
  assert.ok(Math.abs(res.best.T / G - 110) < 0.3, `pencil ${(res.best.T / G).toFixed(2)} (FFT alone ${fftT.toFixed(2)})`);
});

test('a bladed spoke’s flat-face mode is chosen over a louder edge-on twin', () => {
  const blade = { dThread: 2.0, dHead: 2.0, mid: { t: 0.9, d0: 1.4385 }, threadButt: 8, headButt: 30, taper: 10, massFactor: 1.035 };
  const bm = buildSpokeModel({ spoke: blade, lengthMm: 200 });
  const T = 105 * G, fThin = bm.freqAt(T, 'thin'), fWide = bm.freqAt(T, 'wide');
  const pre = 0.15;
  const { x } = synthPluck({ fs, dur: 0.8, pre, seed: 8, partials: [
    { f: fThin, amp: 0.15, decay: 3 }, { f: fWide, amp: 0.22, decay: 3 },
    { f: fThin * bm.ratiosAt(T, 'thin')[1], amp: 0.04, decay: 7 }] });
  const res = analyzePluck(x, fs, { model: bm, preSamples: Math.round(pre * fs) });
  assert.ok(Math.abs(res.best.T / G - 105) < 0.5, `got ${(res.best.T / G).toFixed(2)} kgf; split ${((fWide / fThin - 1) * 100).toFixed(2)} %`);
});
