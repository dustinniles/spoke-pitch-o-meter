// Spoke Pitch-o-meter — UI and audio wiring.
import { G, buildSpokeModel } from './physics.js';
import { PluckDetector, analyzePluck, synthPluck, ANALYSIS } from './dsp.js';
import { wheelGeometry } from './geometry.js';
import { SPOKES, spokeById, spokeLabel } from './spokes.js';

const $ = (id) => document.getElementById(id);
const LBF = 4.4482216;
const UNIT = { kgf: { f: 1 / G, dp: 0 }, N: { f: 1, dp: 0 }, lbf: { f: 1 / LBF, dp: 0 } };
const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();

// --- Persistence (per-device convenience; everything still works without it) --

const store = {
  get(k, d) { try { const v = localStorage.getItem('pitchometer:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pitchometer:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const uid = () => Math.random().toString(36).slice(2, 10);

function defaultSide(spokeId, lengthMm) {
  return {
    spokeId, lengthMm, farEnd: 'cross', targetKgf: null,
    geo: { erd: 600, pcd: 58, offset: 35, crosses: 3, nipple: 12 },
  };
}

function newWheel(base) {
  const w = {
    id: uid(), name: '', type: 'rear', count: 32, hole1: 'R', order: 'side', created: Date.now(),
    sides: { R: defaultSide('dt-competition', 195), L: defaultSide('dt-competition', 195) },
    readings: {}, current: 1, example: false,
  };
  if (base) {
    for (const k of ['type', 'count', 'hole1', 'order']) w[k] = base[k];
    w.sides = JSON.parse(JSON.stringify(base.sides));
  }
  w.current = orderList(w)[0];
  return w;
}

// A plausible rear wheel, clearly marked as an example, so the wheel view has
// something to show before the first real measurement.
function exampleWheel() {
  const w = newWheel();
  Object.assign(w, { name: 'Example rear wheel', type: 'rear', count: 28, example: true });
  w.sides.R = { ...defaultSide('dt-competition', 228), targetKgf: 120 };
  w.sides.L = { ...defaultSide('dt-competition', 226), targetKgf: null };
  let s = 11;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  for (let h = 1; h <= 28; h++) {
    const side = holeSide(w, h);
    const base = side === 'R' ? 121 : 68;
    let t = base * (1 + rnd() * 0.12);
    if (h === 9) t = base * 0.82;
    if (h === 22) t = base * 1.14;
    const T = t * G;
    w.readings[h] = { T, f: 0, plucks: [{ T, f: 0 }], at: Date.now() };
  }
  w.current = 1;
  return w;
}

const state = {
  view: 'gauge',
  mode: store.get('mode', 'single'),
  unit: store.get('unit', 'kgf'),
  gaugeSide: 'R',
  settings: Object.assign({ sensitivity: 18, plucksNeeded: 2, lengthTol: 2 }, store.get('settings', {})),
  calib: store.get('calib', []),
  wheels: store.get('wheels', []),
  wheel: null,
  listening: false,
  last: null,        // last analysed pluck
  chosen: 0,         // index into last.candidates
  lastDemo: true,
};
state.wheel = state.wheels.find((w) => w.id === store.get('currentWheel')) ?? exampleWheel();

function saveAll() {
  if (!state.wheel.example) {
    const i = state.wheels.findIndex((w) => w.id === state.wheel.id);
    if (i >= 0) state.wheels[i] = state.wheel; else state.wheels.unshift(state.wheel);
    store.set('currentWheel', state.wheel.id);
  }
  store.set('wheels', state.wheels);
  store.set('settings', state.settings);
  store.set('calib', state.calib);
  store.set('unit', state.unit);
  store.set('mode', state.mode);
}

// --- Wheel helpers ------------------------------------------------------------

function holeSide(w, h) { return ((h % 2 === 1) === (w.hole1 === 'R')) ? 'R' : 'L'; }

function orderList(w) {
  const holes = Array.from({ length: w.count }, (_, i) => i + 1);
  if (w.order === 'around') return holes;
  return [...holes.filter((h) => holeSide(w, h) === 'R'), ...holes.filter((h) => holeSide(w, h) === 'L')];
}

function sideName(w, s) {
  if (s === 'R') return w.type === 'rear' ? 'Right · drive side' : 'Right side';
  return w.type === 'frontDisc' ? 'Left · rotor side' : (w.type === 'rear' ? 'Left · non-drive' : 'Left side');
}

function sideStats(w, s) {
  const vals = Object.entries(w.readings).filter(([h]) => holeSide(w, +h) === s).map(([h, r]) => ({ h: +h, T: r.T }));
  const total = Array.from({ length: w.count }, (_, i) => i + 1).filter((h) => holeSide(w, h) === s).length;
  if (!vals.length) return { n: 0, total };
  const Ts = vals.map((v) => v.T);
  const mean = Ts.reduce((a, b) => a + b, 0) / Ts.length;
  const sd = Math.sqrt(Ts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, Ts.length - 1));
  const min = Math.min(...Ts), max = Math.max(...Ts);
  const out10 = vals.filter((v) => Math.abs(v.T / mean - 1) > 0.10).length;
  const out20 = vals.filter((v) => Math.abs(v.T / mean - 1) > 0.20).length;
  return { n: vals.length, total, mean, sd, min, max, out10, out20, median: median(Ts) };
}

function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function devClass(d) { const a = Math.abs(d); return a <= 0.10 ? 'good' : a <= 0.20 ? 'warn' : 'bad'; }

// --- Units and formatting -------------------------------------------------------

function fmtT(N, unit = state.unit) { return N == null || !isFinite(N) ? '—' : (N * UNIT[unit].f).toFixed(UNIT[unit].dp); }
function noteName(f) {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const n = 12 * Math.log2(f / 440) + 69;
  const r = Math.round(n);
  const cents = Math.round((n - r) * 100);
  return `${names[(r % 12 + 12) % 12]}${Math.floor(r / 12) - 1} ${cents >= 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

// --- Spoke models ---------------------------------------------------------------

const modelCache = new Map();
function modelFor(side) {
  const spoke = spokeById(side.spokeId);
  const key = `${spoke.id}|${side.lengthMm}|${side.farEnd}`;
  let m = modelCache.get(key);
  if (!m) {
    m = buildSpokeModel({ spoke, lengthMm: side.lengthMm, farEnd: side.farEnd });
    modelCache.set(key, m);
  }
  return m;
}

function activeSideKey() {
  if (state.mode === 'wheel') return holeSide(state.wheel, state.wheel.current);
  return state.gaugeSide;
}
function activeSide() { return state.wheel.sides[activeSideKey()]; }

function calibFactor(spokeId) {
  const rows = state.calib.filter((c) => c.spokeId === spokeId && c.app > 0 && c.ref > 0);
  return rows.length ? median(rows.map((c) => c.ref / c.app)) : 1;
}

function expectedT(sideKey) {
  const st = sideStats(state.wheel, sideKey);
  if (st.n >= 3) return st.median;
  const tgt = state.wheel.sides[sideKey].targetKgf;
  return tgt ? tgt * G : null;
}

// --- Audio ---------------------------------------------------------------------------

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(1024); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pluck-tap', Tap);`;

const audio = { ctx: null, stream: null, src: null, node: null, sink: null, analyser: null, ring: null, written: 0, detector: null, pending: [], wake: null, raf: 0 };

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) {
    micUnavailable(window.isSecureContext ? 'This browser has no microphone access.' : 'Live listening needs a secure (https) page.');
    return;
  }
  try {
    audio.ctx = audio.ctx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await audio.ctx.resume();
    audio.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    // iOS can leave the context suspended or "interrupted" after the permission prompt.
    if (audio.ctx.state !== 'running') await audio.ctx.resume();
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      micUnavailable(inFrame
        ? 'The microphone is blocked inside this embedded page. Open your hosted copy of Spoke Pitch-o-meter to listen live.'
        : 'Microphone access was denied. In Safari, tap the aA menu → Website Settings → Microphone → Allow, then try again.');
    } else micUnavailable('Could not open the microphone (' + (err?.message || name || 'unknown error') + ').');
    return;
  }
  const ctx = audio.ctx;
  const fs = ctx.sampleRate;
  audio.ring = new Float32Array(Math.round(fs * 4));
  audio.written = 0;
  audio.pending = [];
  audio.detector = new PluckDetector(fs, { sensitivityDb: state.settings.sensitivity });
  audio.src = ctx.createMediaStreamSource(audio.stream);
  audio.sink = ctx.createGain(); audio.sink.gain.value = 0; audio.sink.connect(ctx.destination);
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    audio.node = new AudioWorkletNode(ctx, 'pluck-tap');
    audio.node.port.onmessage = (e) => onAudio(e.data);
  } catch {
    audio.node = ctx.createScriptProcessor(2048, 1, 1);
    audio.node.onaudioprocess = (e) => onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  audio.src.connect(audio.node); audio.node.connect(audio.sink);
  audio.analyser = ctx.createAnalyser(); audio.analyser.fftSize = 8192; audio.analyser.smoothingTimeConstant = 0.5;
  audio.src.connect(audio.analyser);
  try { audio.wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  state.listening = true;
  renderListen();
  setStatus('Listening. Pluck lightly about 5 cm from the nipple; rest a finger on the spoke it crosses.');
  liveLoop();
}

function stopListening() {
  state.listening = false;
  cancelAnimationFrame(audio.raf);
  try { audio.src?.disconnect(); audio.node?.disconnect(); audio.analyser?.disconnect(); } catch { /* already gone */ }
  audio.stream?.getTracks().forEach((t) => t.stop());
  audio.stream = null;
  try { audio.wake?.release(); } catch { /* ignore */ }
  audio.wake = null;
  $('meter').style.width = '0%';
  renderListen();
  setStatus('Stopped.');
}

function micUnavailable(msg) {
  state.listening = false;
  renderListen();
  setStatus(msg + ' You can still analyse a voice memo with “Analyse a recording”.', 'warn');
}

function ringRead(start, len) {
  const out = new Float32Array(len);
  const N = audio.ring.length;
  for (let i = 0; i < len; i++) out[i] = audio.ring[(start + i) % N];
  return out;
}

function onAudio(block) {
  const N = audio.ring.length;
  for (let i = 0; i < block.length; i++) audio.ring[(audio.written + i) % N] = block[i];
  const onsets = audio.detector.push(block);
  audio.written += block.length;
  const fs = audio.ctx.sampleRate;
  for (const o of onsets) audio.pending.push(o);
  const need = Math.round((ANALYSIS.tail + 0.02) * fs);
  const pre = Math.round(ANALYSIS.pre * fs);
  while (audio.pending.length && audio.written >= audio.pending[0] + need) {
    const onset = audio.pending.shift();
    if (audio.written - onset + pre > N) continue; // fell out of the buffer
    const seg = ringRead(onset - pre, pre + need);
    processPluck(seg, fs, pre, false);
  }
}

function liveLoop() {
  if (!state.listening) return;
  const lvl = audio.detector ? audio.detector.levelDb : -120;
  $('meter').style.width = Math.max(0, Math.min(100, (lvl + 80) * 1.4)) + '%';
  const now = performance.now();
  if (now - (audio.lastDraw ?? 0) > 50) { drawScope(true); audio.lastDraw = now; }
  audio.raf = requestAnimationFrame(liveLoop);
}

// --- Analysis → UI --------------------------------------------------------------------

function processPluck(x, fs, preSamples, isDemo) {
  const sideKey = activeSideKey();
  const side = state.wheel.sides[sideKey];
  const model = modelFor(side);
  const res = analyzePluck(x, fs, { model, preSamples, expectedT: expectedT(sideKey) });
  if (!res || !res.best) {
    setStatus('No clear ring in that pluck. Pluck a bit firmer, or bring the phone closer.', 'warn');
    return;
  }
  res.at = Date.now();
  res.sideKey = sideKey;
  res.spokeId = side.spokeId;
  res.k = calibFactor(side.spokeId);
  res.demo = isDemo;
  res.model = model;
  state.last = res;
  state.chosen = 0;
  state.lastDemo = isDemo;
  renderReading();
  if (state.mode === 'wheel' && !isDemo) recordPluck(res.candidates[0], res.confidence);
  else if (isDemo) setStatus('Demo pluck, synthesised with crossing-spoke interference. Not recorded.');
  else setStatus(res.confidence >= 0.4 ? 'Got it. Pluck again to check repeatability.' : 'Unsure which peak is the spoke. Damp the crossing spoke and pluck again, or tap the right peak.', res.confidence >= 0.4 ? null : 'warn');
  // A firm pluck rings sharp; the reading is corrected, but say so.
  const g = res.best.glide;
  if (!isDemo && g != null && g > 0.008) {
    setStatus(`That pluck was firm enough to raise the pitch ${(g * 100).toFixed(1)}% at first; the reading is corrected for it. Lighter plucks give steadier results.`, g > 0.02 ? 'warn' : null);
  }
}

function chosenCand() { return state.last?.candidates[state.chosen] ?? null; }

function recordPluck(c, confidence, manual = false) {
  const w = state.wheel;
  if (w.example) { setStatus('This is the example wheel. Start a real wheel on the Wheel tab to record readings.', 'warn'); return; }
  if (!manual && confidence < 0.4) {
    setStatus('Unsure which peak is the spoke, so nothing was recorded. Pluck again, or tap the right peak.', 'warn');
    return;
  }
  const h = w.current;
  const k = state.last.k;
  const r = w.readings[h] ?? { plucks: [] };
  const p = { T: c.T * k, f: c.f, fRaw: c.fRaw ?? c.f, To: c.overtone?.T ?? null, glide: c.glide ?? null };
  if (manual && r.plucks.length) r.plucks[r.plucks.length - 1] = p; else r.plucks.push(p);
  r.plucks = r.plucks.slice(-5);
  const need = +state.settings.plucksNeeded;
  // Find `need` recent plucks that agree within 2.5 %.
  const recent = r.plucks.slice(-Math.max(need, 3));
  let agreeing = null;
  for (let i = 0; i < recent.length && !agreeing; i++) {
    const grp = recent.filter((q) => Math.abs(q.T / recent[i].T - 1) < 0.025);
    if (grp.length >= need) agreeing = grp;
  }
  r.T = agreeing ? median(agreeing.map((q) => q.T)) : median(r.plucks.map((q) => q.T));
  r.f = agreeing ? median(agreeing.map((q) => q.f)) : p.f;
  r.at = Date.now();
  r.done = !!agreeing;
  w.readings[h] = r;
  saveAll();
  if (agreeing) {
    toast(`Spoke ${h}: ${fmtT(r.T)} ${state.unit}`);
    advance(1);
  } else {
    setStatus(`Pluck ${r.plucks.length} recorded. ${need > 1 ? 'Pluck again to confirm.' : ''}`);
  }
  renderSpokeBar();
}

function advance(dir) {
  const list = orderList(state.wheel);
  const i = list.indexOf(state.wheel.current);
  state.wheel.current = list[(i + dir + list.length) % list.length];
  saveAll();
  renderSpokeBar();
  renderContext();
}

function renderReading() {
  const r = state.last;
  const c = chosenCand();
  const big = $('bigT');
  $('bigUnit').textContent = state.unit;
  if (!r || !c) { big.textContent = '—'; big.classList.add('stale'); return; }
  const T = c.T * r.k;
  big.textContent = fmtT(T);
  big.classList.toggle('stale', !!r.demo);
  $('freqOut').textContent = c.f.toFixed(1) + ' Hz';
  $('noteOut').textContent = noteName(c.f);
  const others = ['kgf', 'N', 'lbf'].filter((u) => u !== state.unit).map((u) => `${fmtT(T, u)} ${u}`).join(' · ');
  $('altUnits').textContent = others;
  // Absolute uncertainty: length, spoke data and end conditions, combined.
  const side = state.wheel.sides[r.sideKey];
  const relL = 2.1 * state.settings.lengthTol / side.lengthMm;
  const spoke = spokeById(side.spokeId);
  const relM = spoke.mid.t ? 0.03 : 0.02;
  const rel = Math.sqrt(relL ** 2 + relM ** 2 + 0.04 ** 2);
  $('absErr').textContent = `±${fmtT(T * rel)} ${state.unit} absolute (est.)`;
  // Independent estimate from the overtones; a persistent gap points at the
  // free length or at how rigidly the nipple and crossing hold the spoke.
  const ov = c.overtone;
  const ovEl = $('ovtOut');
  if (ov && !r.demo) {
    const gap = ov.T / c.T - 1;
    ovEl.textContent = `Overtone check ${fmtT(ov.T)} ${state.unit} (${gap >= 0 ? '+' : '−'}${Math.abs(gap * 100).toFixed(0)}%)`;
    ovEl.style.color = Math.abs(gap) > 0.08 ? 'var(--warn)' : '';
  } else { ovEl.textContent = ''; ovEl.style.color = ''; }
  const chip = $('confChip');
  const conf = state.chosen === 0 ? r.confidence : 1;
  const manual = state.chosen !== 0;
  chip.className = 'chip ' + (r.demo ? '' : manual ? 'good' : conf >= 0.7 ? 'good' : conf >= 0.4 ? 'warn' : 'bad');
  chip.textContent = r.demo ? 'Demo' : manual ? 'Your pick' : conf >= 0.7 ? 'Clear' : conf >= 0.4 ? 'Check peaks' : 'Unsure';
  $('scopeHint').textContent = r.demo ? 'Demo pluck' : 'Last pluck';
  renderCands();
  drawScope(false);
}

function renderCands() {
  const r = state.last;
  const box = $('cands');
  box.innerHTML = '';
  if (!r) return;
  r.candidates.slice(0, 5).forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cand';
    b.setAttribute('aria-pressed', String(i === state.chosen));
    b.innerHTML = `<b>${fmtT(c.T * r.k)} ${state.unit}</b><span>${c.f.toFixed(0)} Hz${i === 0 ? ' · best' : ''}${c.pol === 'wide' ? ' · edge-on' : ''}</span>`;
    b.addEventListener('click', () => chooseCandidate(i));
    box.appendChild(b);
  });
}

function chooseCandidate(i) {
  if (!state.last) return;
  state.chosen = i;
  renderReading();
  if (state.mode === 'wheel' && !state.last.demo) {
    recordPluck(state.last.candidates[i], 1, true);
    setStatus('Using the peak you picked.');
  }
}

function setStatus(msg, tone) {
  const p = $('statusText');
  p.textContent = msg;
  p.style.color = tone === 'warn' ? 'var(--warn)' : '';
}

// --- Spectrum plot ------------------------------------------------------------------------

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function drawScope(live) {
  const cv = $('scope');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const ink = cssVar('--ink'), muted = cssVar('--muted'), rule = cssVar('--rule'), accent = cssVar('--accent'), band = cssVar('--band');
  const side = activeSide();
  let model; try { model = modelFor(side); } catch { model = null; }
  const r = state.last;
  const fLo = model ? Math.max(80, model.freqAt(30 * G) * 0.7) : 150;
  const fHi = model ? Math.min(6000, model.freqAt(200 * G) * 2.4) : 3000;
  const top = 22, bottom = H - 18;
  const xOf = (f) => (Math.log(f / fLo) / Math.log(fHi / fLo)) * W;
  const fOf = (x) => fLo * Math.pow(fHi / fLo, x / W);
  // Plausible-tension band.
  if (model) {
    const a = xOf(model.freqAt(50 * G)), b = xOf(model.freqAt(160 * G));
    g.fillStyle = band; g.fillRect(a, top, b - a, bottom - top);
  }
  // Frequency grid.
  g.font = '11px ' + cssVar('--font-data');
  g.fillStyle = muted; g.strokeStyle = rule; g.lineWidth = 1;
  for (const f of [100, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000]) {
    if (f < fLo || f > fHi) continue;
    const x = Math.round(xOf(f)) + 0.5;
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
    g.textAlign = 'center'; g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x, H - 5);
  }
  // Tension scale along the top: where each tension's fundamental would sit.
  if (model) {
    g.textAlign = 'center';
    const unitF = UNIT[state.unit].f;
    const step = state.unit === 'N' ? 250 : state.unit === 'lbf' ? 50 : 25;
    let lastX = -Infinity;
    for (let t = step; t <= 2000; t += step) {
      const TN = t / unitF;
      if (TN / G > 220) break;
      const x = xOf(model.freqAt(TN));
      if (x < 36 || x > W - 16) continue;
      g.fillStyle = muted; g.fillRect(Math.round(x), top - 4, 1, 4);
      // Labels thin out where the scale bunches up at high tension.
      if (x - lastX >= 30) { g.fillText(String(t), x, top - 7); lastX = x; }
    }
    g.textAlign = 'left'; g.fillText(state.unit, 4, top - 7);
  }
  // Traces: the live microphone faintly underneath, the last pluck on top.
  const trace = (spec, color, width) => {
    let mx = -200;
    const k0 = Math.floor(fLo / spec.df), k1 = Math.min(spec.db.length - 1, Math.ceil(fHi / spec.df));
    for (let k = k0; k <= k1; k++) mx = Math.max(mx, spec.db[k]);
    const floor = mx - 60;
    const yOf = (db) => bottom - Math.max(0, (db - floor) / 63) * (bottom - top);
    g.beginPath(); g.strokeStyle = color; g.lineWidth = width;
    for (let x = 0; x <= W; x++) {
      const fa = fOf(x), fb = fOf(x + 1);
      let v = -200;
      for (let k = Math.floor(fa / spec.df); k <= Math.ceil(fb / spec.df); k++) v = Math.max(v, spec.db[k] ?? -200);
      const y = yOf(v);
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    return yOf;
  };
  if (live && audio.analyser) {
    const arr = new Float32Array(audio.analyser.frequencyBinCount);
    audio.analyser.getFloatFrequencyData(arr);
    g.globalAlpha = 0.55;
    trace({ db: arr, df: audio.ctx.sampleRate / audio.analyser.fftSize }, muted, 1);
    g.globalAlpha = 1;
  }
  if (r) {
    const yOf = trace(r.spec, accent, 1.5);
    // Candidate markers; the chosen one gets a dashed drop line.
    r.candidates.slice(0, 5).forEach((c, i) => {
      const x = xOf(c.f), y = yOf(c.level);
      const sel = i === state.chosen;
      g.fillStyle = sel ? ink : muted;
      g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x - 5, y - 12); g.lineTo(x + 5, y - 12); g.closePath(); g.fill();
      if (sel) { g.strokeStyle = ink; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, y); g.lineTo(x, bottom); g.stroke(); g.setLineDash([]); }
    });
    state.scopeMap = { xOf, yOf };
  }
}

$('scope').addEventListener('click', (e) => {
  const r = state.last;
  if (!r || !state.scopeMap) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  let best = -1, bd = 22;
  r.candidates.slice(0, 5).forEach((c, i) => { const d = Math.abs(state.scopeMap.xOf(c.f) - x); if (d < bd) { bd = d; best = i; } });
  if (best >= 0) chooseCandidate(best);
});

// --- Demo, recordings, reference tone ---------------------------------------------------------

function demoPluck() {
  const side = activeSide();
  const model = modelFor(side);
  const base = (side.targetKgf || expectedT(activeSideKey()) / G || 110);
  const tk = base * (0.9 + Math.random() * 0.2);
  const T = tk * G;
  const f1 = model.freqAt(T);
  const rr = model.ratiosAt(T);
  const fs = 48000;
  const partials = [
    { f: f1, amp: 0.22, decay: 3 }, { f: f1 * rr[0], amp: 0.07, decay: 5 }, { f: f1 * rr[1], amp: 0.04, decay: 7 },
    { f: f1 * Math.sqrt(0.58), amp: 0.06, decay: 4 }, { f: f1 * Math.sqrt(0.92), amp: 0.08, decay: 3.5 },
  ];
  const pre = 0.15;
  const { x } = synthPluck({ fs, partials, pre, seed: Math.floor(Math.random() * 1e6) + 1, hum: 0.004 });
  processPluck(x, fs, Math.round(pre * fs), true);
}

async function analyseFile(file) {
  setStatus('Decoding the recording…');
  try {
    const buf = await file.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = audio.ctx || new Ctx();
    audio.ctx = ctx;
    const ab = await ctx.decodeAudioData(buf);
    const fs = ab.sampleRate;
    const x = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) x[i] += d[i] / ab.numberOfChannels; }
    const det = new PluckDetector(fs, { sensitivityDb: state.settings.sensitivity });
    let onsets = [];
    for (let i = 0; i < x.length; i += 1024) onsets.push(...det.push(x.subarray(i, i + 1024)));
    const pre = Math.round(ANALYSIS.pre * fs);
    const need = Math.round((ANALYSIS.tail + 0.02) * fs);
    if (!onsets.length) {
      // No clear onset: treat the loudest moment as the pluck.
      let best = 0, be = 0;
      for (let i = 0; i < x.length - 512; i += 512) { let e = 0; for (let j = 0; j < 512; j++) e += x[i + j] ** 2; if (e > be) { be = e; best = i; } }
      onsets = [best];
    }
    let n = 0;
    for (const o of onsets) {
      const start = Math.max(0, o - pre);
      const seg = x.slice(start, Math.min(x.length, o + need));
      if (seg.length < o - start + fs * 0.1) continue;
      processPluck(seg, fs, o - start, false);
      n++;
      await new Promise((r) => setTimeout(r, 30));
    }
    toast(`Analysed ${n} pluck${n === 1 ? '' : 's'}`);
  } catch (err) {
    setStatus('Could not read that file. Try a .m4a voice memo or a .wav file.', 'warn');
  }
}

function playTone() {
  const side = activeSide();
  const model = modelFor(side);
  const tk = side.targetKgf || (expectedT(activeSideKey()) ?? 110 * G) / G;
  const f = model.freqAt(tk * G);
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audio.ctx = audio.ctx || new Ctx();
  const ctx = audio.ctx;
  ctx.resume();
  const o = ctx.createOscillator(), gn = ctx.createGain();
  o.frequency.value = f; o.type = 'triangle';
  gn.gain.setValueAtTime(0.0001, ctx.currentTime);
  gn.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.01);
  gn.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.6);
  o.connect(gn).connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 1.7);
  setStatus(`Playing ${f.toFixed(0)} Hz (${noteName(f)}), the pitch of this spoke at ${tk.toFixed(0)} kgf.`);
}

// --- Rendering: shell ---------------------------------------------------------------------------

function renderListen() {
  const b = $('listenBtn');
  b.textContent = state.listening ? 'Stop listening' : 'Listen';
  b.classList.toggle('primary', !state.listening);
}

function renderContext() {
  const sk = activeSideKey();
  const side = state.wheel.sides[sk];
  const spoke = spokeById(side.spokeId);
  $('ctxSpoke').textContent = spokeLabel(spoke);
  const far = side.farEnd === 'hub' ? 'to hub' : 'nipple to cross';
  const k = calibFactor(spoke.id);
  $('ctxDetail').innerHTML = `<span class="side-dot ${sk}"></span>${sideName(state.wheel, sk)} · ${side.lengthMm} mm ${far}${k !== 1 ? ` · calibrated ×${k.toFixed(3)}` : ''}`;
}

function renderSpokeBar() {
  const bar = $('spokeBar');
  bar.hidden = state.mode !== 'wheel';
  if (bar.hidden) return;
  const w = state.wheel;
  const h = w.current;
  const s = holeSide(w, h);
  const list = orderList(w);
  $('spokeLabel').textContent = `Spoke ${h}`;
  $('spokeSub').textContent = `${sideName(w, s)} · ${list.indexOf(h) + 1} of ${list.length}${w.example ? ' · example wheel' : ''}`;
  const r = w.readings[h];
  const pl = $('pluckList');
  pl.innerHTML = '';
  (r?.plucks ?? []).forEach((p) => { const sp = document.createElement('span'); sp.textContent = fmtT(p.T); pl.appendChild(sp); });
  if (r?.done) { const sp = document.createElement('span'); sp.textContent = '✓ ' + fmtT(r.T); sp.style.fontWeight = '600'; pl.appendChild(sp); }
}

function renderMode() {
  document.querySelectorAll('#modeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  // In wheel mode the side follows the spoke being measured.
  $('sideSeg').hidden = state.mode === 'wheel';
  document.querySelectorAll('#sideSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === state.gaugeSide)));
  renderSpokeBar();
  renderContext();
}

function renderUnits() {
  document.querySelectorAll('#unitSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));
}

function show(view) {
  state.view = view;
  for (const v of ['gauge', 'wheel', 'setup', 'about']) $('view-' + v).hidden = v !== view;
  document.querySelectorAll('.tabbar button').forEach((b) => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (view === 'wheel') renderWheel();
  if (view === 'setup') renderSetup();
  if (view === 'about') renderAbout();
  if (view === 'gauge') { renderContext(); renderSpokeBar(); requestAnimationFrame(() => drawScope(false)); }
  window.scrollTo(0, 0);
}

// --- Rendering: wheel ---------------------------------------------------------------------------

function renderWheel() {
  const w = state.wheel;
  $('exampleBanner').hidden = !w.example;
  $('wheelTitle').textContent = w.name || 'Untitled wheel';
  $('dlCsv').hidden = inFrame;
  const fig = $('wheelFig');
  const cx = 200, cy = 200, rRim = 178, rHub = 26;
  const vals = Object.values(w.readings).map((r) => r.T);
  const tMaxK = Math.max(60, Math.ceil(((vals.length ? Math.max(...vals) : 120 * G) / G * 1.12) / 20) * 20);
  const rOf = (TN) => rHub + 8 + (TN / G / tMaxK) * (rRim - rHub - 14);
  const ang = (h) => -Math.PI / 2 + (h - 0.5) * 2 * Math.PI / w.count;
  const P = (h, rad) => [cx + rad * Math.cos(ang(h)), cy + rad * Math.sin(ang(h))];
  const stats = { R: sideStats(w, 'R'), L: sideStats(w, 'L') };
  let s = '';
  // Rings in the display unit.
  const unitF = UNIT[state.unit].f;
  const ringStepK = tMaxK > 140 ? 50 : 25;
  for (let t = ringStepK; t <= tMaxK; t += ringStepK) {
    const rr = rOf(t * G);
    s += `<circle cx="${cx}" cy="${cy}" r="${rr.toFixed(1)}" fill="none" stroke="var(--rule)" stroke-width="1"/>`;
    s += `<text x="${cx + 4}" y="${(cy - rr + 14).toFixed(1)}" font-size="13" fill="var(--muted)" font-family="var(--font-data)">${Math.round(t * G * unitF)}</text>`;
  }
  s += `<circle cx="${cx}" cy="${cy}" r="${rRim}" fill="none" stroke="var(--ink)" stroke-width="3"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${rHub}" fill="var(--panel)" stroke="var(--ink)" stroke-width="1.5"/>`;
  // Valve hole at the top.
  s += `<rect x="${cx - 4}" y="${cy - rRim - 9}" width="8" height="12" rx="2" fill="var(--ink)"/>`;
  s += `<text x="${cx - 7}" y="${cy - rRim + 17}" font-size="13" text-anchor="end" fill="var(--muted)">valve</text>`;
  // Side means.
  for (const sk of ['R', 'L']) {
    const st = stats[sk];
    if (!st.n) continue;
    s += `<circle cx="${cx}" cy="${cy}" r="${rOf(st.mean).toFixed(1)}" fill="none" stroke="var(--${sk === 'R' ? 'accent' : 'left'})" stroke-width="1.4" stroke-dasharray="1.5 4" stroke-linecap="round"/>`;
  }
  // Spokes and readings.
  for (let h = 1; h <= w.count; h++) {
    const sk = holeSide(w, h);
    const [x1, y1] = P(h, rHub), [x2, y2] = P(h, rRim - 2);
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--rule)" stroke-width="1"/>`;
    const [lx, ly] = P(h, rRim + 12);
    s += `<text x="${lx.toFixed(1)}" y="${(ly + 4.5).toFixed(1)}" font-size="13" text-anchor="middle" fill="var(--muted)" font-family="var(--font-data)">${h}</text>`;
  }
  for (const sk of ['R', 'L']) {
    const pts = [];
    for (let h = 1; h <= w.count; h++) if (holeSide(w, h) === sk && w.readings[h]) pts.push(P(h, rOf(w.readings[h].T)));
    if (pts.length > 2) s += `<polygon points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--${sk === 'R' ? 'accent' : 'left'})" stroke-width="1.8" stroke-linejoin="round"${sk === 'L' ? ' stroke-dasharray="6 4"' : ''}/>`;
  }
  const hits = [];
  for (let h = 1; h <= w.count; h++) {
    const r = w.readings[h];
    const sk = holeSide(w, h);
    const cur = h === w.current;
    if (cur) { const [x, y] = P(h, rRim - 2); s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="var(--ink)"/>`; }
    if (!r) continue;
    const dev = r.T / stats[sk].mean - 1;
    const cls = devClass(dev);
    const [x, y] = P(h, rOf(r.T));
    // Deviation is carried by size and outline too, not colour alone.
    const rad = cls === 'good' ? 4.5 : cls === 'warn' ? 6.5 : 8;
    const edge = cls === 'bad' ? 'stroke="var(--ink)" stroke-width="2"' : 'stroke="var(--panel)" stroke-width="1.5"';
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}" fill="var(--${cls})" ${edge}/>`;
    if (cur) s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad + 4}" fill="none" stroke="var(--ink)" stroke-width="1.5"/>`;
    hits.push(`<circle data-hole="${h}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16" fill="rgba(0,0,0,0)" style="cursor:pointer"><title>Spoke ${h}: ${fmtT(r.T)} ${state.unit} (${(dev * 100).toFixed(0)}%)</title></circle>`);
  }
  // Generous invisible tap areas on top of the dots.
  s += hits.join('');
  fig.innerHTML = s;
  $('wheelLegend').innerHTML = `<span class="side-dot R"></span>Right side, solid line. <span class="side-dot L"></span>Left side, dashed line. Dotted rings mark each side's average; rings are labelled in ${state.unit}. Dots show each spoke's distance from its side's average: small and green within 10%, larger and amber within 20%, largest, red and outlined beyond that. Tap a dot or a table row to re-measure that spoke.`;

  // Stats.
  const sb = $('stats');
  sb.innerHTML = '';
  for (const sk of ['R', 'L']) {
    const st = stats[sk];
    const el = document.createElement('div');
    el.className = 'stat';
    const cls = !st.n ? '' : st.out20 ? 'bad' : st.out10 ? 'warn' : 'good';
    el.innerHTML = `<div class="k"><span class="side-dot ${sk}"></span><b class="small">${sideName(w, sk)}</b></div>
      ${st.n ? `<div><span class="data" style="font-size:22px;font-weight:600">${fmtT(st.mean)}</span> <span class="muted small">${state.unit} avg</span></div>
      <dl><dt>Measured</dt><dd>${st.n}/${st.total}</dd><dt>Range</dt><dd>${fmtT(st.min)}–${fmtT(st.max)}</dd>
      <dt>Std dev</dt><dd>${(st.sd / st.mean * 100).toFixed(1)}%</dd><dt>Beyond ±10%</dt><dd>${st.out10}</dd></dl>
      <span class="chip ${cls}">${st.out20 ? st.out20 + ' beyond ±20%' : st.out10 ? 'Close; true it up' : 'Even'}</span>` : `<p class="small muted">No readings yet.</p>`}`;
    sb.appendChild(el);
  }
  if (stats.R.n && stats.L.n) {
    const el = document.createElement('div');
    el.className = 'stat'; el.style.gridColumn = '1 / -1';
    el.innerHTML = `<dl><dt>Left ÷ right average</dt><dd>${(stats.L.mean / stats.R.mean * 100).toFixed(0)}%</dd></dl>`;
    sb.appendChild(el);
  }

  // Table in measuring order.
  const tb = $('spokeTable');
  let t = `<thead><tr><th>Spoke</th><th>Side</th><th>${state.unit}</th><th>vs avg</th><th>Hz</th></tr></thead><tbody>`;
  for (const h of orderList(w)) {
    const r = w.readings[h];
    const sk = holeSide(w, h);
    const dev = r ? r.T / stats[sk].mean - 1 : null;
    t += `<tr data-hole="${h}" class="${h === w.current ? 'sel' : ''}"><td>${h}</td><td><span class="side-dot ${sk}"></span>${sk}</td><td>${r ? fmtT(r.T) : '—'}</td>
      <td class="dev ${dev == null ? '' : devClass(dev)}">${dev == null ? '' : (dev >= 0 ? '+' : '−') + Math.abs(dev * 100).toFixed(1) + '%'}</td><td>${r && r.f ? r.f.toFixed(0) : ''}</td></tr>`;
  }
  tb.innerHTML = t + '</tbody>';
  renderSaved();
}

function gotoSpoke(h) {
  state.wheel.current = h;
  state.mode = 'wheel';
  saveAll();
  renderMode();
  show('gauge');
}

$('wheelFig').addEventListener('click', (e) => { const h = e.target.closest('[data-hole]')?.dataset.hole; if (h) gotoSpoke(+h); });
$('spokeTable').addEventListener('click', (e) => { const h = e.target.closest('tr[data-hole]')?.dataset.hole; if (h) gotoSpoke(+h); });

function csv() {
  const w = state.wheel;
  const rows = [['spoke', 'side', 'tension_kgf', 'tension_N', 'frequency_Hz', 'plucks', 'overtone_check_kgf', 'pitch_glide_pct', 'spoke_type', 'free_length_mm']];
  for (const h of orderList(w)) {
    const r = w.readings[h];
    const sk = holeSide(w, h);
    const side = w.sides[sk];
    const ov = r ? r.plucks.map((p) => p.To).filter((v) => v) : [];
    const gl = r ? r.plucks.map((p) => p.glide).filter((v) => v != null) : [];
    rows.push([h, sk, r ? (r.T / G).toFixed(1) : '', r ? r.T.toFixed(0) : '', r?.f ? r.f.toFixed(2) : '', r ? r.plucks.map((p) => (p.T / G).toFixed(1)).join(' ') : '',
      ov.length ? (median(ov) / G).toFixed(1) : '', gl.length ? (median(gl) * 100).toFixed(2) : '', spokeLabel(spokeById(side.spokeId)), side.lengthMm]);
  }
  return rows.map((r) => r.map((v) => /[",\s]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
}

$('copyCsv').addEventListener('click', () => {
  const text = csv();
  navigator.clipboard?.writeText(text).then(() => toast('CSV copied'), () => fallbackCopy(text));
  if (!navigator.clipboard) fallbackCopy(text);
});
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('CSV copied'); } catch { toast('Copy failed'); }
  ta.remove();
}
$('dlCsv').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv()], { type: 'text/csv' }));
  a.download = (state.wheel.name || 'wheel').replace(/[^\w-]+/g, '_') + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

function startNewWheel() {
  const base = state.wheel.example ? null : state.wheel;
  state.wheel = newWheel(base);
  state.mode = 'wheel';
  saveAll();
  renderMode();
  show('setup');
  toast('New wheel started. Check the spoke details, then measure.');
}
$('newWheelBtn').addEventListener('click', startNewWheel);
$('newWheelBtn2').addEventListener('click', startNewWheel);
$('measureBtn').addEventListener('click', () => { state.mode = 'wheel'; saveAll(); renderMode(); show('gauge'); });

function renderSaved() {
  const box = $('savedList');
  const list = state.wheels;
  if (!list.length) { box.innerHTML = '<p class="muted">Wheels you measure are kept on this device and listed here.</p>'; return; }
  box.innerHTML = '';
  for (const w of list) {
    const n = Object.keys(w.readings).length;
    const row = document.createElement('div');
    row.className = 'sidehead saved-row';
    row.innerHTML = `<div><b>${escapeHtml(w.name || 'Untitled wheel')}</b>${w.id === state.wheel.id ? ' <span class="chip good">open</span>' : ''}<div class="muted">${new Date(w.created).toLocaleDateString()} · ${w.count} spokes · ${n} measured</div></div>`;
    const btns = document.createElement('div');
    btns.className = 'row'; btns.style.flexWrap = 'nowrap';
    if (w.id !== state.wheel.id) {
      const open = document.createElement('button'); open.className = 'btn'; open.type = 'button'; open.textContent = 'Open';
      open.addEventListener('click', () => { state.wheel = w; saveAll(); renderWheel(); renderMode(); });
      btns.appendChild(open);
    }
    const del = document.createElement('button'); del.className = 'btn destructive'; del.type = 'button'; del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (del.dataset.armed) {
        state.wheels = state.wheels.filter((x) => x.id !== w.id);
        if (state.wheel.id === w.id) state.wheel = state.wheels[0] ?? exampleWheel();
        saveAll(); renderWheel(); renderMode();
      } else { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete'; }, 3000); }
    });
    btns.appendChild(del);
    row.appendChild(btns);
    box.appendChild(row);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// --- Rendering: setup ---------------------------------------------------------------------------

function spokeOptions(selected) {
  const groups = {};
  for (const s of SPOKES) (groups[s.maker] ??= []).push(s);
  return Object.entries(groups).map(([m, list]) => `<optgroup label="${m}">${list.map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${escapeHtml(s.name)} · ${escapeHtml(s.profile)}</option>`).join('')}</optgroup>`).join('');
}

function renderSidePanel(sk) {
  const w = state.wheel;
  const side = w.sides[sk];
  const el = $('sidePanel' + sk);
  const p = sk;
  const g = side.geo;
  el.innerHTML = `
    <div class="sidehead"><h3><span class="side-dot ${sk}"></span>${sideName(w, sk)} spokes</h3>${sk === 'L' ? '<button type="button" class="btn" id="copyRL">Same as right</button>' : ''}</div>
    <div class="fields">
      <div class="field full"><label for="${p}spoke">Spoke</label><select id="${p}spoke">${spokeOptions(side.spokeId)}</select>
        <span class="help" id="${p}note"></span></div>
      <div class="field"><label for="${p}len">Free length (mm)</label><input id="${p}len" type="number" inputmode="decimal" min="40" max="400" step="0.5" value="${side.lengthMm}"></div>
      <div class="field"><label for="${p}far">Measured to</label>
        <select id="${p}far"><option value="cross" ${side.farEnd === 'cross' ? 'selected' : ''}>The cross</option><option value="hub" ${side.farEnd === 'hub' ? 'selected' : ''}>The hub</option></select></div>
      <div class="field full help">Measure from where the spoke leaves the nipple to the middle of the crossing where it touches another spoke. For radial spokes, or crossings that don't touch, measure to the hub flange and choose “The hub”.</div>
      <div class="field"><label for="${p}tgt">Target (kgf, optional)</label><input id="${p}tgt" type="number" inputmode="decimal" min="10" max="250" step="1" value="${side.targetKgf ?? ''}"></div>
      <div class="field full"><div class="calc-out" id="${p}pitch">—</div></div>
    </div>
    <details class="more"><summary>Calculate the free length from wheel geometry</summary>
      <div class="fields">
        <div class="field"><label for="${p}erd">Rim ERD (mm)</label><input id="${p}erd" type="number" inputmode="decimal" step="0.5" value="${g.erd}"></div>
        <div class="field"><label for="${p}cross">Crosses</label><select id="${p}cross">${[0, 1, 2, 3, 4].map((c) => `<option value="${c}" ${c === g.crosses ? 'selected' : ''}>${c === 0 ? 'Radial' : c + '×'}</option>`).join('')}</select></div>
        <div class="field"><label for="${p}pcd">Flange hole circle Ø (mm)</label><input id="${p}pcd" type="number" inputmode="decimal" step="0.5" value="${g.pcd}"></div>
        <div class="field"><label for="${p}off">Centre to flange (mm)</label><input id="${p}off" type="number" inputmode="decimal" step="0.5" value="${g.offset}"></div>
        <div class="field"><label for="${p}nip">Nipple length (mm)</label><select id="${p}nip">${[12, 14, 16].map((n) => `<option ${n === g.nipple ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label>Result</label><div class="calc-out data" id="${p}geoOut">—</div></div>
      </div>
      <div class="row" style="margin-top:10px"><button type="button" class="btn" id="${p}useGeo">Use this free length</button></div>
    </details>`;
  const upd = () => {
    side.spokeId = $(p + 'spoke').value;
    const L = parseFloat($(p + 'len').value);
    if (L >= 40 && L <= 400) side.lengthMm = L;
    side.farEnd = $(p + 'far').value;
    const tg = parseFloat($(p + 'tgt').value);
    side.targetKgf = tg > 0 ? tg : null;
    Object.assign(side.geo, {
      erd: parseFloat($(p + 'erd').value) || g.erd, crosses: +$(p + 'cross').value,
      pcd: parseFloat($(p + 'pcd').value) || g.pcd, offset: parseFloat($(p + 'off').value) || g.offset, nipple: +$(p + 'nip').value,
    });
    saveAll();
    refreshSideOutputs(sk);
    renderContext();
  };
  el.querySelectorAll('input, select').forEach((i) => i.addEventListener('change', upd));
  $(p + 'useGeo').addEventListener('click', () => {
    const r = geoFor(sk);
    side.lengthMm = Math.round(r.freeLength * 2) / 2;
    side.farEnd = r.farEnd;
    $(p + 'len').value = side.lengthMm;
    $(p + 'far').value = side.farEnd;
    saveAll(); refreshSideOutputs(sk); renderContext();
    toast(`Free length set to ${side.lengthMm} mm`);
  });
  if (sk === 'L') $('copyRL').addEventListener('click', () => {
    w.sides.L = JSON.parse(JSON.stringify(w.sides.R));
    saveAll(); renderSidePanel('L'); renderContext();
  });
  refreshSideOutputs(sk);
}

function geoFor(sk) {
  const g = state.wheel.sides[sk].geo;
  return wheelGeometry({ erd: g.erd, spokes: state.wheel.count, crosses: g.crosses, flangePcd: g.pcd, flangeOffset: g.offset, nippleLen: g.nipple });
}

function refreshSideOutputs(sk) {
  const side = state.wheel.sides[sk];
  const p = sk;
  const spoke = spokeById(side.spokeId);
  $(p + 'note').textContent = spoke.note || '';
  const tk = side.targetKgf || 110;
  try {
    const m = modelFor(side);
    const f = m.freqAt(tk * G);
    const naive = m.stringTension(f) / G;
    $(p + 'pitch').innerHTML = `At ${tk} kgf this spoke rings at <b class="data">${f.toFixed(0)} Hz</b> (${noteName(f)}). The plain string formula would read that pitch as ${naive.toFixed(0)} kgf.`;
  } catch { $(p + 'pitch').textContent = '—'; }
  const r = geoFor(sk);
  $(p + 'geoOut').innerHTML = `spoke ≈ ${r.length.toFixed(1)} mm<br>free ≈ ${r.freeLength.toFixed(1)} mm ${r.farEnd === 'hub' ? '(to hub)' : '(to cross)'}`;
}

function renderSetup() {
  const w = state.wheel;
  $('wName').value = w.name;
  $('wType').value = w.type;
  $('wCount').value = String(w.count);
  $('wHole1').value = w.hole1;
  $('wOrder').value = w.order;
  $('sSens').value = state.settings.sensitivity;
  $('sSensOut').textContent = state.settings.sensitivity + ' dB';
  $('sPlucks').value = String(state.settings.plucksNeeded);
  $('sTol').value = state.settings.lengthTol;
  renderSidePanel('R');
  renderSidePanel('L');
  renderCalib();
}

function bindWheelFields() {
  const upd = () => {
    const w = state.wheel;
    if (w.example) {
      // Editing the example turns it into a real wheel with these settings.
      state.wheel = newWheel(w);
    }
    const ww = state.wheel;
    ww.name = $('wName').value.trim();
    ww.type = $('wType').value;
    const cnt = +$('wCount').value;
    if (cnt !== ww.count) { ww.count = cnt; ww.readings = Object.fromEntries(Object.entries(ww.readings).filter(([h]) => +h <= cnt)); }
    ww.hole1 = $('wHole1').value;
    ww.order = $('wOrder').value;
    if (!orderList(ww).includes(ww.current)) ww.current = orderList(ww)[0];
    saveAll();
    renderSidePanel('R'); renderSidePanel('L'); renderContext();
  };
  for (const id of ['wName', 'wType', 'wCount', 'wHole1', 'wOrder']) $(id).addEventListener('change', upd);
  $('sSens').addEventListener('input', () => {
    state.settings.sensitivity = +$('sSens').value;
    $('sSensOut').textContent = state.settings.sensitivity + ' dB';
    if (audio.detector) audio.detector.sensitivityDb = state.settings.sensitivity;
    saveAll();
  });
  $('sPlucks').addEventListener('change', () => { state.settings.plucksNeeded = +$('sPlucks').value; saveAll(); });
  $('sTol').addEventListener('change', () => { const v = parseFloat($('sTol').value); if (v >= 0) state.settings.lengthTol = v; saveAll(); });
}

function renderCalib() {
  $('cSpoke').innerHTML = spokeOptions(activeSide().spokeId);
  const box = $('calibList');
  if (!state.calib.length) { box.innerHTML = '<p class="muted">No reference pairs. Readings use the physics model as-is.</p>'; return; }
  box.innerHTML = '';
  const bySpoke = {};
  state.calib.forEach((c, i) => (bySpoke[c.spokeId] ??= []).push({ ...c, i }));
  for (const [id, rows] of Object.entries(bySpoke)) {
    const head = document.createElement('p');
    head.innerHTML = `<b>${escapeHtml(spokeLabel(spokeById(id)))}</b>: factor ×${calibFactor(id).toFixed(3)}`;
    box.appendChild(head);
    for (const r of rows) {
      const line = document.createElement('div');
      line.className = 'sidehead';
      line.innerHTML = `<span class="data">${(r.app / G).toFixed(1)} → ${(r.ref / G).toFixed(1)} kgf (×${(r.ref / r.app).toFixed(3)})</span>`;
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn destructive'; del.textContent = 'Remove';
      del.addEventListener('click', () => { state.calib.splice(r.i, 1); saveAll(); renderCalib(); renderContext(); });
      line.appendChild(del);
      box.appendChild(line);
    }
  }
}
$('cAdd').addEventListener('click', () => {
  const app = parseFloat($('cApp').value), ref = parseFloat($('cRef').value);
  if (!(app > 0 && ref > 0)) { toast('Enter both readings in kgf'); return; }
  state.calib.push({ spokeId: $('cSpoke').value, app: app * G, ref: ref * G, at: Date.now() });
  $('cApp').value = ''; $('cRef').value = '';
  saveAll(); renderCalib(); renderContext();
});
$('cUseLast').addEventListener('click', () => {
  const c = chosenCand();
  if (!state.last || !c || state.last.demo) { toast('Take a real reading first'); return; }
  $('cApp').value = (c.T / G).toFixed(1);
  $('cSpoke').value = state.last.spokeId;
});

// --- About ------------------------------------------------------------------------------------------

function renderAbout() {
  const side = activeSide();
  const m = modelFor(side);
  const f = m.freqAt(110 * G);
  const naive = m.stringTension(f) / G;
  $('aboutProse').innerHTML = `
    <h2>How the Pitch-o-meter works</h2>
    <p>A tight spoke rings like a guitar string: the tighter it is, the higher the note. Pluck it, and the microphone hears that note. From the spoke's mass, stiffness and free length, the app works out the tension that would make it ring at exactly that pitch.</p>
    <h3>What it does differently</h3>
    <ul>
      <li><b>It treats the spoke as a stiff beam, not a string.</b> A spoke resists bending, which raises its pitch, most of all at low tension and near the nipple, where it's held rigidly. The classic formula <span class="data">T = 4·μ·L²·f²</span> ignores this and reads high. The Pitch-o-meter solves the tensioned-beam equation along the actual spoke, butted ends and bladed sections included.</li>
      <li><b>It identifies the right peak.</b> A plucked spoke in a wheel also excites the spoke it crosses and the pair as a whole. Each candidate is checked for its overtone fingerprint (a stiff spoke's overtones sit slightly sharp of whole multiples), how long it rings, and how far it stands above the room noise. When two peaks are close calls, it says so, and you can tap the right one.</li>
      <li><b>It corrects for how hard you pluck.</b> A firm pluck stretches the spoke and raises its pitch until the ring dies down; a 2 mm pluck can read 5% high. The app follows the pitch as the ring decays and works back to what it would be at zero amplitude.</li>
      <li><b>It cross-checks with the overtones.</b> A stiff spoke's overtones sit slightly sharp of whole multiples, by an amount that depends on tension but hardly at all on how the ends are held. That gives a second, independent estimate, shown under each reading as the overtone check. A steady gap between the two points to the free length or to the end conditions.</li>
      <li><b>It reports uncertainty.</b> Every reading shows an estimated absolute error and, while mapping a wheel, waits for plucks that agree.</li>
    </ul>
    <h3>Checked against a load cell</h3>
    <p>Thomas Wilson tested the original iPhone app on Industry Nine's load-cell rig with a Sapim CX-Ray. Its readings drifted from 10% high at 45 kgf to 3.5% low at 155 kgf. That is the signature of ignoring bending stiffness. Fitting the plain string formula to his twelve points leaves a systematic error of 3.4 kgf RMS. The beam model used here leaves 0.7 kgf, which is the old app's display resolution. That test checks the shape of the correction; the absolute scale still rests on the spoke data and your length measurement.</p>
    <h3>Spoke data</h3>
    <p>Diameters come from DT Swiss, Sapim and Pillar. Real spoke wire runs slightly heavy: DT's published weights for its plain-gauge Champion spokes are about 3.5% above the nominal wire size, so masses are scaled up by that much. Butt lengths aren't published; they shift readings by less than 1%. Steel is taken as 7.92 g/cm³ with a modulus of 190 GPa.</p>
    <h3>Your current spoke, worked through</h3>
    <p>${escapeHtml(spokeLabel(spokeById(side.spokeId)))}, ${side.lengthMm} mm free: at 110 kgf it rings at <span class="data">${f.toFixed(1)} Hz</span> (${noteName(f)}). The plain string formula would call that pitch <span class="data">${naive.toFixed(0)} kgf</span>, ${((naive / 110 - 1) * 100).toFixed(0)}% high.</p>
    <div class="formula">EI·w'''' − T·w'' + μ·ẅ = 0 · clamped at the nipple, pinned at the cross<br>finite-element solution, ${m.tables.thin.length} tensions × ${m.polarizations.length} bending plane${m.polarizations.length > 1 ? 's' : ''}</div>
    <h3>Getting good readings</h3>
    <ul>
      <li>Measure the free length carefully. Tension goes with length squared, so a 2 mm error on a 200 mm segment is about 2% in tension. The geometry calculator in Setup gives the length if you know the ERD and hub dimensions.</li>
      <li>Rest a fingertip on the spoke it crosses, near the cross. This damps the partner spoke and makes the crossing behave like a fixed point.</li>
      <li>Pluck sideways and lightly, about a quarter of the way along the free length from the nipple (roughly 5 cm), with a fingernail or a plastic pick. Light plucks need less correction, and plucking there rings both overtones the cross-check uses; plucking dead centre or a third of the way along silences one of them. For bladed spokes, pluck across the flat face.</li>
      <li>Hold the phone 10–20 cm away, bottom edge (the microphone) toward the spoke, in a quiet room.</li>
    </ul>
    <h3>How accurate is it?</h3>
    <p>Spoke-to-spoke comparisons, which are what truing needs, repeat to about 1%. Absolute tension depends on the free length you enter, the spoke's published dimensions, and how rigidly the nipple and the crossing hold the spoke. Expect roughly ±4–6% until you calibrate against a trusted reference. For scale, a load-cell test of shop tensiometers found the Park TM-1 and Wheel Fanatyk reading about 100 N low and the DT Swiss Tensio about 100 N high using their own charts.</p>
    <h3>Background</h3>
    <ul>
      <li>Douglas Pepelko's <i>Spoke Tension Gauge</i> (iOS, 2012–2016) pioneered this on phones; its Android sibling is <a href="https://www.mega-mouse.net/" target="_blank" rel="noopener">Spoke Tensioner</a>.</li>
      <li>Thomas Wilson, <a href="https://savetheneurons.blogspot.com/2019/01/your-spoke-tension-meter-is-probably.html" target="_blank" rel="noopener">“Your spoke tension meter is probably…”</a> (2019): the load-cell comparison above.</li>
      <li><a href="https://www.ihpva.org/HParchive/PDF/hp53-2002.pdf" target="_blank" rel="noopener"><i>Human Power</i> No. 53</a> (2002): 140 spokes, tensiometer vs. pitch, with an empirical stiffness length correction that matches this model.</li>
      <li><a href="https://www.sheldonbrown.com/spoke-pitch.html" target="_blank" rel="noopener">Sheldon Brown: Check spoke tension by ear</a>.</li>
    </ul>
    <p class="small muted">Spoke Pitch-o-meter is an independent tool, not affiliated with any of the above. Never exceed your rim maker's maximum tension.</p>`;
}

// --- Wiring -------------------------------------------------------------------------------------------

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
document.querySelectorAll('#unitSeg button').forEach((b) => b.addEventListener('click', () => {
  state.unit = b.dataset.unit; saveAll(); renderUnits(); renderReading(); renderSpokeBar();
  if (state.view === 'wheel') renderWheel();
}));
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  if (state.mode === 'wheel' && state.wheel.example) toast('Showing the example wheel. Start a real one from the Wheel tab.');
  saveAll(); renderMode(); drawScope(false);
}));
$('contextChip').addEventListener('click', () => show('setup'));
document.querySelectorAll('#sideSeg button').forEach((b) => b.addEventListener('click', () => {
  state.gaugeSide = b.dataset.side;
  renderMode(); drawScope(false);
}));
$('prevSpoke').addEventListener('click', () => advance(-1));
$('nextSpoke').addEventListener('click', () => advance(1));
$('listenBtn').addEventListener('click', () => (state.listening ? stopListening() : startListening()));
$('demoBtn').addEventListener('click', demoPluck);
$('toneBtn').addEventListener('click', playTone);
$('fileIn').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) analyseFile(f); e.target.value = ''; });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.listening && !audio.wake) {
    try { audio.wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }
});
window.addEventListener('resize', () => drawScope(false));
const mq = window.matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener?.('change', () => { drawScope(false); });
new MutationObserver(() => drawScope(false)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

bindWheelFields();
renderUnits();
renderMode();
renderListen();
show('gauge');
// Open on a worked example so the gauge shows what a reading looks like.
demoPluck();
setStatus('Tap Listen, then pluck a spoke lightly about 5 cm from the nipple. The reading above is a synthesised example.');
if ('serviceWorker' in navigator && !inFrame && location.protocol === 'https:' && document.querySelector('link[rel="manifest"]')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
