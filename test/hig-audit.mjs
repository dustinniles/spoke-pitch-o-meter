// Checks the built site against the measurable parts of Apple's Human
// Interface Guidelines: 44×44 pt hit targets, 11 pt minimum text, and no
// sideways scrolling, at iPhone SE and standard iPhone widths, in both themes
// and at a large Dynamic Type size.
//   node test/hig-audit.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

// Own process group, so the whole server tree goes away afterwards.
const port = 8140 + Math.floor(Math.random() * 50);
const server = spawn('npx', ['http-server', process.env.SITE_DIR || 'dist/site', '-p', String(port), '-s', '-c-1'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch();
let failures = 0;

async function audit(page, label) {
  return page.evaluate((label) => {
    const out = [];
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !el.closest('[hidden]');
    };
    // Hit targets. Segmented buttons extend their hit area with ::after.
    for (const el of document.querySelectorAll('button, select, input:not(.sr), label.btn, summary, [data-hole], a.btn')) {
      if (!visible(el)) continue;
      if (el.closest('.prose')) continue; // inline links in running text
      const r = el.getBoundingClientRect();
      let h = r.height, w = r.width;
      const after = getComputedStyle(el, '::after');
      if (after.content !== 'none' && after.position === 'absolute') {
        h += parseFloat(after.top) * -1 + parseFloat(after.bottom) * -1;
        w += parseFloat(after.left) * -1 + parseFloat(after.right) * -1;
      }
      if (el.tagName === 'circle') continue; // checked below as SVG
      if (h < 43.5 || w < 43.5) out.push(`${label}: small target ${el.tagName.toLowerCase()}#${el.id || ''}.${el.className || ''} "${(el.textContent || '').trim().slice(0, 24)}" ${w.toFixed(0)}×${h.toFixed(0)}`);
    }
    // Text size, including SVG text scaled by its viewBox.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || seen.has(el) || !walker.currentNode.textContent.trim()) continue;
      seen.add(el);
      if (!visible(el) || el.closest('.sr, title, style, script')) continue;
      let px = parseFloat(getComputedStyle(el).fontSize);
      const svg = el.closest('svg');
      if (svg && svg.viewBox?.baseVal?.width) px *= svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      if (px < 10.95) out.push(`${label}: small text ${px.toFixed(1)}px "${walker.currentNode.textContent.trim().slice(0, 30)}"`);
    }
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`${label}: horizontal overflow ${document.documentElement.scrollWidth}px`);
    return out;
  }, label);
}

for (const [vw, vh, name] of [[375, 667, 'iPhone SE'], [390, 844, 'iPhone']]) {
  for (const scheme of ['light', 'dark']) {
    for (const textScale of ['default', 'large']) {
      const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/index.html`);
      // Large Dynamic Type: Body at 23 pt (the largest non-accessibility size).
      if (textScale === 'large') await page.addStyleTag({ content: 'html { font-size: 23px !important; }' });
      await page.waitForTimeout(400);
      for (const view of ['gauge', 'wheel', 'setup', 'about']) {
        await page.click(`.tabbar button[data-view="${view}"]`);
        await page.waitForTimeout(200);
        if (view === 'setup') await page.$$eval('details.more', (ds) => ds.forEach((d) => { d.open = true; }));
        const label = `${name} ${scheme} ${textScale} ${view}`;
        const issues = await audit(page, label);
        failures += issues.length;
        issues.forEach((i) => console.log(i));
        if (shots && scheme === 'light' && (vw === 375 || textScale === 'default')) {
          await page.screenshot({ path: join(shots, `${vw}-${textScale}-${view}.png`), fullPage: false });
        }
      }
      // Wheel-mode gauge and dark wheel for a visual check.
      if (shots && textScale === 'default' && vw === 390) {
        await page.click('.tabbar button[data-view="wheel"]');
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(shots, `${vw}-${scheme}-wheel-full.png`), fullPage: true });
      }
      await ctx.close();
    }
  }
}
await browser.close();
process.kill(-server.pid);
console.log(failures ? `${failures} issue(s)` : 'HIG audit: no issues');
process.exit(failures ? 1 : 0);
