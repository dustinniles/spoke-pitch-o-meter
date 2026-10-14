// End-to-end: serve dist/site, feed Chromium a fake microphone WAV of plucks at
// known tensions, and read what the app displays. Also captures screenshots.
//   node test/e2e.mjs [outdir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { buildSpokeModel, G } from '../src/physics.js';
import { synthPluck } from '../src/dsp.js';
import { spokeById } from '../src/spokes.js';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const out = process.argv[2] || 'test/out';
mkdirSync(out, { recursive: true });

// --- Build the fake-mic WAV -------------------------------------------------
const fs = 48000;
const model = buildSpokeModel({ spoke: spokeById('dt-competition'), lengthMm: 195, farEnd: 'cross' });
const tensions = [112, 112, 96, 96, 128, 128];
const gap = 1.6;
const total = new Float32Array(Math.round(fs * (gap * tensions.length + 1.5)));
tensions.forEach((tk, i) => {
  const T = tk * G, f1 = model.freqAt(T), r = model.ratiosAt(T);
  const { x } = synthPluck({
    fs, dur: 1.2, pre: 0, seed: 100 + i, noise: 0.002, hum: 0.003,
    partials: [{ f: f1, amp: 0.25, decay: 3 }, { f: f1 * r[0], amp: 0.08, decay: 5 }, { f: f1 * r[1], amp: 0.04, decay: 7 }],
    extra: [{ f: f1 * Math.sqrt(65 / 113), amp: 0.07, decay: 4 }, { f: f1 * Math.sqrt(104 / 113), amp: 0.09, decay: 3 }],
  });
  const off = Math.round(fs * (0.8 + i * gap));
  for (let j = 0; j < x.length && off + j < total.length; j++) total[off + j] += x[j];
});
// Room noise everywhere.
let s = 1; for (let i = 0; i < total.length; i++) { s = (s * 16807) % 2147483647; total[i] += (s / 2147483647 - 0.5) * 0.004; }
const wav = Buffer.alloc(44 + total.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + total.length * 2, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(fs, 24); wav.writeUInt32LE(fs * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(total.length * 2, 40);
for (let i = 0; i < total.length; i++) wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(total[i] * 32767))), 44 + i * 2);
const wavPath = resolve(out, 'plucks.wav');
writeFileSync(wavPath, wav);

// --- Serve and drive ------------------------------------------------------------
const server = spawn('npx', ['http-server', 'dist/site', '-p', '8123', '-s', '-c-1'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`, '--autoplay-policy=no-user-gesture-required'],
});
const results = { errors: [], readings: [] };
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') results.errors.push(m.text()); });
  page.on('pageerror', (e) => results.errors.push(String(e)));
  await page.goto('http://localhost:8123/index.html');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'gauge-initial.png'), fullPage: true });
  // Start a real wheel (defaults: DT Competition, 195 mm to the cross) and map it.
  await page.click('.tabbar button[data-view="wheel"]');
  await page.click('#newWheelBtn2');
  await page.click('.tabbar button[data-view="gauge"]');
  await page.click('#listenBtn');
  let last = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const v = await page.evaluate(() => [document.getElementById('bigT').textContent, document.getElementById('freqOut').textContent, document.getElementById('confChip').textContent, document.getElementById('statusText').textContent].join(' | '));
    if (v !== last) { results.readings.push(((Date.now() - t0) / 1000).toFixed(1) + 's  ' + v); last = v; }
    await page.waitForTimeout(100);
  }
  await page.screenshot({ path: join(out, 'gauge-listening.png'), fullPage: true });
  await page.click('#listenBtn');
  results.wheel = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('pitchometer:wheels'))[0];
    return Object.entries(w.readings).map(([h, r]) => `spoke ${h}: ${(r.T / 9.80665).toFixed(1)} kgf from ${r.plucks.map((p) => (p.T / 9.80665).toFixed(1)).join(', ')}`);
  });
  for (const v of ['wheel', 'setup', 'about']) {
    await page.click(`.tabbar button[data-view="${v}"]`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${v}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('.tabbar button[data-view="gauge"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'gauge-dark.png'), fullPage: true });
  await page.click('.tabbar button[data-view="wheel"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'wheel-dark.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  results.horizontalOverflow = overflow;
} finally {
  await browser.close();
  server.kill();
}
console.log('expected (kgf):', tensions.join(', '));
console.log(results.readings.join('\n'));
console.log('wheel readings:\n' + (results.wheel || []).join('\n'));
console.log('errors:', results.errors.length ? results.errors : 'none');
console.log('horizontal overflow:', results.horizontalOverflow);
