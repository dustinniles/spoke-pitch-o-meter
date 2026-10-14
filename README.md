# Spoke Pitch-o-meter

Measure bicycle spoke tension from the sound of a plucked spoke. A web-app successor to Douglas Pepelko's *Spoke Tension Gauge* (iOS, 2012–2016), rebuilt with a stiff-beam physics model instead of the ideal-string formula.

## Put it on your iPhone

Open **<https://dustinniles.github.io/spoke-pitch-o-meter/>** in Safari → Share → **Add to Home Screen**. It launches full-screen and works offline after the first visit. The first time you tap **Listen**, Safari asks for the microphone; allow it.

Every push to `main` runs the unit tests, rebuilds, and redeploys the site through GitHub Actions (`.github/workflows/pages.yml`).

To host it anywhere else, run `node tools/build.mjs` and upload `dist/site` to any static host that serves **https** (the microphone needs it), for example by dragging the folder onto <https://app.netlify.com/drop>.

## Using it

1. **Setup tab:** choose the spoke and enter the **free length**. That's the distance from where the spoke leaves the nipple to the middle of the crossing where it touches another spoke. For radial spokes, or crossings that don't touch, measure to the hub flange and set "Far end" to "Runs to the hub flange". You can also compute the length from ERD, flange diameter, flange offset and cross pattern.
2. **Gauge tab:** tap **Listen**. Rest a fingertip on the spoke that crosses the one you're measuring, near the cross, and pluck sideways near the middle of the free length. Bladed spokes: pluck across the flat face.
3. **Map a wheel:** each spoke records once two plucks agree within 2.5%, then the gauge moves to the next spoke. The **Wheel** tab shows the tension map, per-side statistics, and spokes beyond ±10% / ±20% of their side's average. Tap any spoke to re-measure it.
4. If a reading says **Unsure**, the pluck had two plausible peaks. Pluck again with the crossing spoke damped, or tap the right peak in the spectrum or the chips below it.

No microphone (for example inside the claude.ai preview)? **Analyse a recording** accepts a Voice Memo. Turn off Voice Memos' "Enhance Recording" first.

## How accurate is it

- **Spoke-to-spoke:** pluck-to-pluck repeatability is about 1%. That's what truing and tension balancing need.
- **Absolute:** roughly ±5%. The free length matters most: ±2 mm on a 195 mm segment is about ±2.5%. Spoke mass data and how rigidly the nipple and crossing hold the spoke make up the rest.
- **Load-cell check:** Thomas Wilson's 2019 test of the original app shows its error drifting from +10% at 45 kgf to −3.5% at 155 kgf. Fitted to his data, the plain string formula leaves 3.4 kgf RMS of systematic error; this beam model leaves 0.7 kgf. Run `node tools/wilson-fit.mjs` to reproduce it.
- **Calibration:** if you ever get access to a trusted reference (a load cell, a crane scale in a simple rig, a good tensiometer), enter pairs in Setup → Calibration. The median ratio is applied to that spoke type.

## What's inside

| Path | What |
|---|---|
| `src/physics.js` | Finite-element tensioned-beam model (Hermite elements, banded Cholesky, inverse iteration); spoke profiles; f⇄T tables |
| `src/dsp.js` | FFT, pluck detector, spectrum peak finder, candidate scoring (overtone fingerprint, sustain, SNR, bladed-spoke twin modes), synthetic plucks |
| `src/geometry.js` | Spoke length and interlaced-cross position from wheel geometry |
| `src/spokes.js` | Spoke database (DT Swiss, Sapim, Pillar, Wheelsmith, plain gauge), with sources and the mass-factor rationale |
| `src/app.js`, `src/index.template.html` | UI, microphone pipeline (AudioWorklet, ScriptProcessor fallback), wheel mapping |
| `tools/build.mjs` | Inlines everything into `dist/spoke-pitch-o-meter.html` (single file) and `dist/site/` (PWA, what Pages serves) |
| `tools/wilson-fit.mjs` | The load-cell comparison above |
| `test/` | Unit tests (`node --test test/*.test.mjs`) and a Chromium fake-microphone end-to-end test (`node test/e2e.mjs`) |

Build with `node tools/build.mjs`. There are no dependencies beyond Node 18+; the e2e test uses Playwright.

## References

- Thomas Wilson, "Your spoke tension meter is probably…" (2019): <https://savetheneurons.blogspot.com/2019/01/your-spoke-tension-meter-is-probably.html>
- Mega-Mouse *Spoke Tensioner* (Android sibling of the original): <https://www.mega-mouse.net/>
- *Human Power* No. 53 (2002), tensiometer vs. musical pitch on 140 spokes: <https://www.ihpva.org/HParchive/PDF/hp53-2002.pdf>
- Bobbit, Kazi & Li, "Acoustic Spoke Tensiometer for Bicycle Wheels", UIUC ECE 445 (2012)
- Sheldon Brown / John Allen, "Check spoke tension by ear": <https://www.sheldonbrown.com/spoke-pitch.html>

Spoke Pitch-o-meter is independent and not affiliated with any of the above. Never exceed your rim maker's maximum tension.
