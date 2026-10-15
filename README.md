# Spoke Pitch-o-meter

Measure bicycle spoke tension from the sound of a plucked spoke. A web-app successor to Douglas Pepelko's *Spoke Tension Gauge* (iOS, 2012–2016), rebuilt with a stiff-beam physics model instead of the ideal-string formula.

## Put it on your iPhone

Open **<https://dustinniles.com/spoke-pitch-o-meter/>** in Safari → Share → **Add to Home Screen**. It launches full-screen and works offline after the first visit. The first time you tap **Listen**, Safari asks for the microphone; allow it.

Every push to `main` runs the unit tests, rebuilds, and redeploys the site through GitHub Actions (`.github/workflows/pages.yml`).

To host it anywhere else, run `node tools/build.mjs` and upload `dist/site` to any static host that serves **https** (the microphone needs it), for example by dragging the folder onto <https://app.netlify.com/drop>.

## Using it

1. **Setup tab:** choose the spoke and enter the **free length**. That's the distance from where the spoke leaves the nipple to the middle of the crossing where it touches another spoke. For radial spokes, or crossings that don't touch, measure to the hub flange and set "Measured to" to "The hub". You can also compute the length from ERD, flange diameter, flange offset and cross pattern.
2. **Gauge tab:** tap **Listen**. Rest a fingertip on the spoke that crosses the one you're measuring, near the cross, and pluck sideways and lightly, about a quarter of the way along the free length from the nipple (roughly 5 cm). Bladed spokes: pluck across the flat face.
3. **Measure under fair conditions:** tire off or deflated (an inflated tire squeezes the rim and lowers every spoke), after stress relieving, with wind-up taken out of each spoke. Spokes beside the rim joint, opposite the valve, often read a little low.
4. **Map a wheel:** each spoke records once two plucks agree within 2.5%, then the gauge moves to the next spoke. The **Wheel** tab shows the tension map, per-side statistics, and spokes beyond ±10% / ±20% of their side's average. Tap any spoke to re-measure it. Build in rounds: **Start next round** keeps the previous map, so the table shows what each adjustment did. The **Balancing plan** follows Jobst Brandt's rule: bring an odd spoke to its side's median in quarter turns, and give its two same-side neighbours half the opposite turn, so the rim stays true. Tension per turn is estimated from the spoke (about 9–11 kgf per quarter turn for DT spokes); enter your own figure in Setup if you measure it.
5. If a reading says **Unsure**, the pluck had two plausible peaks. Pluck again with the crossing spoke damped, or tap the right peak in the spectrum or the chips below it.

No microphone handy, or want to measure from a recording? **Analyse a recording** accepts a Voice Memo. Turn off Voice Memos' "Enhance Recording" first.

## How accurate is it

- **Spoke-to-spoke:** pluck-to-pluck repeatability is about 1%. That's what truing and tension balancing need.
- **Absolute:** roughly ±5–7%. The free length matters most: ±2 mm on a 195 mm segment is about ±2.7%. The rest is spoke mass data and, above all, how the nipple and the crossing hold the spoke.
- **Pluck strength:** a firm pluck stretches the spoke and rings sharp until it decays (Legge & Fletcher 1984). The app tracks the pitch through the decay and extrapolates to zero amplitude.
- **Close modes:** a bladed spoke's two bending planes, or a spoke and its crossing partner, can sit under 1% apart and merge into one FFT peak. Each leading peak is re-fitted with the matrix pencil method (Hua & Sarkar 1990).
- **The crossing is the open question.** The spoke runs on past the cross to the hub, which raises the pitch 3–4% compared with the pinned model. A springy crossing lowers it by about as much or more. Frequencies alone can't separate the two ends (Geuzaine, Foti & Denoël 2021), so the model stays with the middle case. The **overtone check** (2nd and 3rd partials) barely depends on the ends, and its average gap per side on the Wheel tab measures the real behaviour on your wheels.
- **Load-cell check:** Thomas Wilson's 2019 test of the original app shows its error drifting from +10% at 45 kgf to −3.5% at 155 kgf. Fitted to his data, the plain string formula leaves 3.4 kgf RMS of systematic error; this beam model leaves 0.7 kgf. Run `node tools/wilson-fit.mjs` to reproduce it.
- **Calibration:** if you ever get access to a trusted reference (a load cell, a crane scale in a simple rig, a good tensiometer), enter pairs in Setup → Calibration. The median ratio is applied to that spoke type.

## What's inside

| Path | What |
|---|---|
| `src/physics.js` | Finite-element tensioned-beam model (Hermite elements, banded Cholesky, inverse iteration); spoke profiles; f⇄T tables |
| `src/dsp.js` | FFT, pluck detector, spectrum peak finder, candidate scoring (overtone fingerprint, sustain, SNR, bladed-spoke twin modes), pitch-glide correction, overtone cross-check, synthetic plucks |
| `src/pencil.js` | Matrix pencil method (complex baseband, Jacobi eigensolver) for splitting modes under 1% apart |
| `src/geometry.js` | Spoke length and interlaced-cross position from wheel geometry |
| `src/build.js` | Tension per nipple turn and Brandt's balancing plan |
| `src/spokes.js` | Spoke database (DT Swiss, Sapim, Pillar, Wheelsmith, plain gauge), with sources and the mass-factor rationale |
| `src/app.js`, `src/index.template.html` | UI, microphone pipeline (AudioWorklet, ScriptProcessor fallback), wheel mapping |
| `tools/build.mjs` | Inlines everything into one page and writes the deployable site to `dist/site/` (what Pages serves) |
| `tools/wilson-fit.mjs` | The load-cell comparison above |
| `test/` | Unit tests (`node --test test/*.test.mjs`), a Chromium fake-microphone end-to-end test (`node test/e2e.mjs`), and an Apple HIG audit (`node test/hig-audit.mjs`: 44 pt hit targets, 11 pt minimum text, no sideways scrolling, at iPhone SE and iPhone widths, light and dark, default and large Dynamic Type) |

Build with `node tools/build.mjs`. There are no dependencies beyond Node 18+; the e2e test uses Playwright.

## References

- Thomas Wilson, "Your spoke tension meter is probably…" (2019): <https://savetheneurons.blogspot.com/2019/01/your-spoke-tension-meter-is-probably.html>
- Mega-Mouse *Spoke Tensioner* (Android sibling of the original): <https://www.mega-mouse.net/>
- *Human Power* No. 53 (2002), tensiometer vs. musical pitch on 140 spokes: <https://www.ihpva.org/HParchive/PDF/hp53-2002.pdf>
- Bobbit, Kazi & Li, "Acoustic Spoke Tensiometer for Bicycle Wheels", UIUC ECE 445 (2012)
- Jobst Brandt, *The Bicycle Wheel*, 3rd ed., Avocet (ISBN 0-9607236-6-8)
- Sheldon Brown / John Allen, "Check spoke tension by ear": <https://www.sheldonbrown.com/spoke-pitch.html>
- Papadopoulos, US Patent 5,103,414, "Method for trueing spoked wheels" (1992): about 43 kgf per full nipple turn on a 2.0 mm spoke
- Geuzaine, Foti & Denoël, "On the identification of the axial force and bending stiffness of stay cables anchored to flexible supports", J. Sound Vib. 511 (2021)
- Legge & Fletcher, "Nonlinear generation of missing modes on a vibrating string", JASA 76 (1984), doi:10.1121/1.391007
- Hua & Sarkar, "Matrix pencil method for estimating parameters of exponentially damped/undamped sinusoids in noise", IEEE TASSP 38 (1990), doi:10.1109/29.56027
- Weinreich, "Coupled piano strings", JASA 62 (1977), doi:10.1121/1.381677
- Ford, "Reinventing the Wheel: Stiffness and Strength of Bicycle Wheels", PhD thesis, Northwestern University (2018)

Spoke Pitch-o-meter is independent and not affiliated with any of the above. Never exceed your rim maker's maximum tension.
