// Inline the modules into one HTML page.
//   dist/spoke-pitch-o-meter.html  — single file for the claude.ai link (no PWA tags)
//   dist/site/             — self-hostable copy with manifest, service worker, icons
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, 'src', f), 'utf8');

const order = ['physics.js', 'dsp.js', 'geometry.js', 'spokes.js', 'app.js'];
const body = order.map((f) => {
  const code = src(f)
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function|class|let)/gm, '$1');
  return `// ---- ${f} ----\n${code}`;
}).join('\n');
const script = `(() => {\n'use strict';\n${body}\n})();`;
const template = src('index.template.html');

const pwaHead = [
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="icon-180.png">',
  '<link rel="icon" href="icon-192.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Pitch-o-meter">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<meta name="theme-color" content="#e8ecef" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#0d1317" media="(prefers-color-scheme: dark)">',
].join('\n');

const fill = (head) => template.replace('<!--PWA_HEAD-->', head).replace('/*APP_SCRIPT*/', () => script);

mkdirSync(join(root, 'dist', 'site'), { recursive: true });
// Artifact page: the publisher supplies the document skeleton.
writeFileSync(join(root, 'dist', 'spoke-pitch-o-meter.html'), fill(''));
// Self-hosted page: a full document.
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n${fill(pwaHead)}\n</body>\n</html>\n`;
writeFileSync(join(root, 'dist', 'site', 'index.html'), full);

const version = Date.now().toString(36);
writeFileSync(join(root, 'dist', 'site', 'manifest.webmanifest'), JSON.stringify({
  name: 'Spoke Pitch-o-meter', short_name: 'Pitch-o-meter', description: 'Spoke tension from the sound of a plucked spoke.',
  start_url: './', scope: './', display: 'standalone', background_color: '#e8ecef', theme_color: '#e8ecef',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));
writeFileSync(join(root, 'dist', 'site', 'sw.js'), `// Offline cache for Spoke Pitch-o-meter.
const CACHE = 'spoke-pitch-o-meter-${version}';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !font) return;
  // Network first for the page (so updates arrive), cache first for the rest.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })));
});
`);
for (const f of ['icon-180.png', 'icon-192.png', 'icon-512.png']) {
  const p = join(root, 'assets', f);
  if (existsSync(p)) copyFileSync(p, join(root, 'dist', 'site', f));
}
console.log('built', (script.length / 1024).toFixed(0) + ' KB script');
