// Does the beam model explain the original app's error pattern in Thomas
// Wilson's 2019 load-cell test (Sapim CX-Ray, Industry Nine rig)?
// The app used the ideal-string formula, so its reading should equal
//   k · T_true · S(T_true),  S = (f_beam / f_string)²
// where k is an unknown constant (its spoke mass and entered length).
import { buildSpokeModel, G } from '../src/physics.js';

const load = [155.45, 145.10, 134.75, 125.30, 114.45, 105.3, 95.4, 84.9, 75.45, 65.25, 55.8, 45.45];
const app = [150, 141, 132, 124, 114, 106, 97, 90, 79, 69, 61, 50];

function fit(S) {
  // Least squares for k in app ≈ k · load · S.
  const x = load.map((t, i) => t * S[i]);
  const k = x.reduce((a, v, i) => a + v * app[i], 0) / x.reduce((a, v) => a + v * v, 0);
  const res = x.map((v, i) => app[i] - k * v);
  const rms = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length);
  return { k, rms, res };
}

const flat = fit(load.map(() => 1));
console.log(`ideal string, scale only:   rms ${flat.rms.toFixed(2)} kgf   residuals ${flat.res.map((r) => r.toFixed(1)).join(' ')}`);

const cx = (threadButt) => ({ dThread: 2.0, dHead: 2.0, mid: { w: 2.2, t: 0.9 }, threadButt, headButt: threadButt, taper: 8 });
for (const L of [250, 270, 290]) {
  for (const tb of [0, 10, 20]) {
    for (const pol of ['thin', 'wide']) {
      const m = buildSpokeModel({ spoke: cx(tb), lengthMm: L, farEnd: 'hub', polarizations: [pol] });
      const S = load.map((t) => (m.freqAt(t * G, pol) / (Math.sqrt(t * G / m.muMean) / (2 * L / 1000))) ** 2);
      const r = fit(S);
      console.log(`beam L=${L} butt=${String(tb).padStart(2)} ${pol.padEnd(4)}: rms ${r.rms.toFixed(2)} kgf  k=${r.k.toFixed(3)}  residuals ${r.res.map((v) => v.toFixed(1)).join(' ')}`);
    }
  }
}

// Same comparison without the 84.9 kgf row, whose app reading (90) breaks the
// trend of its neighbours in both fits.
{
  const drop = 7;
  const L2 = load.filter((_, i) => i !== drop), A2 = app.filter((_, i) => i !== drop);
  const fit2 = (S) => {
    const x = L2.map((t, i) => t * S[i]);
    const k = x.reduce((a, v, i) => a + v * A2[i], 0) / x.reduce((a, v) => a + v * v, 0);
    return Math.sqrt(x.reduce((a, v, i) => a + (A2[i] - k * v) ** 2, 0) / x.length);
  };
  const m = buildSpokeModel({ spoke: cx(15), lengthMm: 270, farEnd: 'hub', polarizations: ['thin'] });
  const S = L2.map((t) => (m.freqAt(t * G) / (Math.sqrt(t * G / m.muMean) / (2 * 270 / 1000))) ** 2);
  console.log(`\nwithout the 84.9 kgf row: ideal string rms ${fit2(L2.map(() => 1)).toFixed(2)} kgf, beam (L=270, butt 15, thin) rms ${fit2(S).toFixed(2)} kgf`);
}
