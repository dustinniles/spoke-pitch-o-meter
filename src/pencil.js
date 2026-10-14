// Matrix pencil method (Hua & Sarkar 1990) for sums of damped complex
// exponentials. Used to split modes too close for the FFT to separate, such
// as a bladed spoke's two bending planes or a spoke and its crossing partner.

// Eigen-decomposition of a real symmetric matrix by cyclic Jacobi rotations.
// A is n×n, row-major Float64Array (destroyed). Returns { values, vectors }
// with vectors as columns of an n×n row-major array.
function jacobiSym(A, n) {
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p], akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k], aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = A[i * n + i];
  return { values, vectors: V };
}

// Small complex matrix helpers; matrices are { re, im } row-major, n×m.
function cmatMul(a, b, n, k, m) {
  const re = new Float64Array(n * m), im = new Float64Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    let sr = 0, si = 0;
    for (let l = 0; l < k; l++) {
      const ar = a.re[i * k + l], ai = a.im[i * k + l], br = b.re[l * m + j], bi = b.im[l * m + j];
      sr += ar * br - ai * bi; si += ar * bi + ai * br;
    }
    re[i * m + j] = sr; im[i * m + j] = si;
  }
  return { re, im };
}

function cconjT(a, n, m) {
  const re = new Float64Array(m * n), im = new Float64Array(m * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { re[j * n + i] = a.re[i * m + j]; im[j * n + i] = -a.im[i * m + j]; }
  return { re, im };
}

// Solve A X = B for square complex A (n×n), B (n×m), Gaussian elimination
// with partial pivoting.
function csolve(A, B, n, m) {
  const ar = Float64Array.from(A.re), ai = Float64Array.from(A.im);
  const br = Float64Array.from(B.re), bi = Float64Array.from(B.im);
  for (let c = 0; c < n; c++) {
    let piv = c, best = -1;
    for (let r = c; r < n; r++) { const mag = ar[r * n + c] ** 2 + ai[r * n + c] ** 2; if (mag > best) { best = mag; piv = r; } }
    if (best < 1e-300) throw new Error('singular');
    if (piv !== c) {
      for (let k = 0; k < n; k++) { [ar[c * n + k], ar[piv * n + k]] = [ar[piv * n + k], ar[c * n + k]]; [ai[c * n + k], ai[piv * n + k]] = [ai[piv * n + k], ai[c * n + k]]; }
      for (let k = 0; k < m; k++) { [br[c * m + k], br[piv * m + k]] = [br[piv * m + k], br[c * m + k]]; [bi[c * m + k], bi[piv * m + k]] = [bi[piv * m + k], bi[c * m + k]]; }
    }
    const pr = ar[c * n + c], pi = ai[c * n + c], pd = pr * pr + pi * pi;
    for (let r = c + 1; r < n; r++) {
      // f = A[r][c] / A[c][c]
      const xr = ar[r * n + c], xi = ai[r * n + c];
      const fr = (xr * pr + xi * pi) / pd, fi = (xi * pr - xr * pi) / pd;
      for (let k = c; k < n; k++) {
        const yr = ar[c * n + k], yi = ai[c * n + k];
        ar[r * n + k] -= fr * yr - fi * yi; ai[r * n + k] -= fr * yi + fi * yr;
      }
      for (let k = 0; k < m; k++) {
        const yr = br[c * m + k], yi = bi[c * m + k];
        br[r * m + k] -= fr * yr - fi * yi; bi[r * m + k] -= fr * yi + fi * yr;
      }
    }
  }
  const xr = new Float64Array(n * m), xi = new Float64Array(n * m);
  for (let k = 0; k < m; k++) {
    for (let r = n - 1; r >= 0; r--) {
      let sr = br[r * m + k], si = bi[r * m + k];
      for (let c = r + 1; c < n; c++) {
        const ur = ar[r * n + c], ui = ai[r * n + c], vr = xr[c * m + k], vi = xi[c * m + k];
        sr -= ur * vr - ui * vi; si -= ur * vi + ui * vr;
      }
      const pr = ar[r * n + r], pi = ai[r * n + r], pd = pr * pr + pi * pi;
      xr[r * m + k] = (sr * pr + si * pi) / pd; xi[r * m + k] = (si * pr - sr * pi) / pd;
    }
  }
  return { re: xr, im: xi };
}

// Eigenvalues of a small complex matrix: Faddeev–LeVerrier characteristic
// polynomial, then Aberth–Ehrlich root polishing. Fine for n ≤ 8 with
// eigenvalues near the unit circle, which is all the pencil produces.
function cEigenvalues(A, n) {
  // c[k] are coefficients of λ^n + c1 λ^(n-1) + … + cn.
  const I = { re: new Float64Array(n * n), im: new Float64Array(n * n) };
  for (let i = 0; i < n; i++) I.re[i * n + i] = 1;
  let Mk = { re: new Float64Array(n * n), im: new Float64Array(n * n) };
  const cr = [1], ci = [0];
  for (let k = 1; k <= n; k++) {
    // M_k = A M_{k-1} + c_{k-1} I
    const AM = cmatMul(A, Mk, n, n, n);
    for (let i = 0; i < n; i++) { AM.re[i * n + i] += cr[k - 1]; AM.im[i * n + i] += ci[k - 1]; }
    Mk = AM;
    const AMk = cmatMul(A, Mk, n, n, n);
    let tr = 0, ti = 0;
    for (let i = 0; i < n; i++) { tr += AMk.re[i * n + i]; ti += AMk.im[i * n + i]; }
    cr.push(-tr / k); ci.push(-ti / k);
  }
  // Roots of the polynomial with Aberth iterations.
  const pr = cr, pi = ci;
  const evalP = (zr, zi) => {
    let vr = 1, vi = 0, dr = 0, di = 0;
    for (let k = 1; k <= n; k++) {
      // derivative: d = d*z + v ; value: v = v*z + c_k
      const ndr = dr * zr - di * zi + vr, ndi = dr * zi + di * zr + vi;
      const nvr = vr * zr - vi * zi + pr[k], nvi = vr * zi + vi * zr + pi[k];
      dr = ndr; di = ndi; vr = nvr; vi = nvi;
    }
    return [vr, vi, dr, di];
  };
  const zr = new Float64Array(n), zi = new Float64Array(n);
  for (let k = 0; k < n; k++) { const a = 2 * Math.PI * (k + 0.25) / n + 0.4; zr[k] = 0.9 * Math.cos(a); zi[k] = 0.9 * Math.sin(a); }
  for (let it = 0; it < 500; it++) {
    let maxStep = 0;
    for (let k = 0; k < n; k++) {
      const [vr, vi, dr, di] = evalP(zr[k], zi[k]);
      const dd = dr * dr + di * di;
      if (dd === 0) continue;
      // ratio = p / p'
      const rr = (vr * dr + vi * di) / dd, ri = (vi * dr - vr * di) / dd;
      let sr = 0, si = 0;
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const ar = zr[k] - zr[j], ai = zi[k] - zi[j], ad = ar * ar + ai * ai || 1e-300;
        sr += ar / ad; si += -ai / ad;
      }
      // w = ratio / (1 - ratio * s)
      const qr = 1 - (rr * sr - ri * si), qi = -(rr * si + ri * sr), qd = qr * qr + qi * qi;
      const wr = (rr * qr + ri * qi) / qd, wi = (ri * qr - rr * qi) / qd;
      zr[k] -= wr; zi[k] -= wi;
      maxStep = Math.max(maxStep, Math.hypot(wr, wi));
    }
    if (maxStep < 1e-13) break;
  }
  return Array.from({ length: n }, (_, k) => ({ re: zr[k], im: zi[k] }));
}

// Fit `order` damped complex exponentials to the complex series (re, im)
// sampled at rate `rate`. Returns poles sorted by amplitude:
// { freq (Hz, relative to baseband), damping (1/s), amp }.
export function matrixPencil(re, im, rate, { order = 6, pencil = null } = {}) {
  const N = re.length;
  const L = pencil ?? Math.min(32, Math.floor(N / 3));
  const rows = N - L, cols = L + 1;
  // Y^H Y as a Hermitian matrix, embedded in a real symmetric one.
  const n = cols;
  const Hr = new Float64Array(n * n), Hi = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sr = 0, si = 0;
      for (let r = 0; r < rows; r++) {
        // conj(Y[r][i]) * Y[r][j], Y[r][c] = z[r + c]
        const ar = re[r + i], ai = -im[r + i], br = re[r + j], bi = im[r + j];
        sr += ar * br - ai * bi; si += ar * bi + ai * br;
      }
      Hr[i * n + j] = sr; Hi[i * n + j] = si;
      Hr[j * n + i] = sr; Hi[j * n + i] = -si;
    }
  }
  const S = new Float64Array(4 * n * n);
  const n2 = 2 * n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    S[i * n2 + j] = Hr[i * n + j]; S[i * n2 + j + n] = -Hi[i * n + j];
    S[(i + n) * n2 + j] = Hi[i * n + j]; S[(i + n) * n2 + j + n] = Hr[i * n + j];
  }
  const { values, vectors } = jacobiSym(S, n2);
  // Eigenvalues come in equal pairs; take one vector from each of the top pairs.
  const idx = Array.from({ length: n2 }, (_, i) => i).sort((a, b) => values[b] - values[a]);
  const M = Math.min(order, cols - 1);
  const Vr = new Float64Array(cols * M), Vi = new Float64Array(cols * M);
  for (let m = 0; m < M; m++) {
    const c = idx[2 * m];
    for (let r = 0; r < cols; r++) { Vr[r * M + m] = vectors[r * n2 + c]; Vi[r * M + m] = vectors[(r + n) * n2 + c]; }
  }
  // Pencil: V1 = V without its last row, V2 = V without its first row.
  // Poles are the eigenvalues of pinv(V1)·V2 = (V1^H V1)^-1 V1^H V2.
  const V1 = { re: Vr.subarray(0, (cols - 1) * M), im: Vi.subarray(0, (cols - 1) * M) };
  const V2 = { re: Vr.subarray(M), im: Vi.subarray(M) };
  const V1h = cconjT(V1, cols - 1, M);
  const G = cmatMul(V1h, V1, M, cols - 1, M);
  const R = cmatMul(V1h, V2, M, cols - 1, M);
  const P = csolve(G, R, M, M);
  // Working from the right singular vectors (Y = UΣVᴴ) yields the poles'
  // complex conjugates, so flip them back.
  const poles = cEigenvalues(P, M).map((z) => ({ re: z.re, im: -z.im }));
  // Amplitudes by least squares on the Vandermonde system.
  const Zr = new Float64Array(N * M), Zi = new Float64Array(N * M);
  poles.forEach((p, m) => {
    let pr = 1, pi = 0;
    for (let t = 0; t < N; t++) { Zr[t * M + m] = pr; Zi[t * M + m] = pi; const nr = pr * p.re - pi * p.im; pi = pr * p.im + pi * p.re; pr = nr; }
  });
  const Z = { re: Zr, im: Zi };
  const Zh = cconjT(Z, N, M);
  let amps;
  try {
    amps = csolve(cmatMul(Zh, Z, M, N, M), cmatMul(Zh, { re: Float64Array.from(re), im: Float64Array.from(im) }, M, N, 1), M, 1);
  } catch { return []; }
  return poles.map((p, m) => ({
    freq: Math.atan2(p.im, p.re) * rate / (2 * Math.PI),
    damping: -Math.log(Math.hypot(p.re, p.im)) * rate,
    amp: Math.hypot(amps.re[m], amps.im[m]),
  })).sort((a, b) => b.amp - a.amp);
}

// Shift a real signal down by fc and decimate to roughly `rate` Hz with a
// third-order CIC (three cascaded moving averages), giving a complex series.
export function baseband(x, fs, start, len, fc, rate = 240) {
  const D = Math.max(1, Math.round(fs / rate));
  const out = Math.floor((len - 3 * D) / D);
  if (out < 24) return null;
  const w = 2 * Math.PI * fc / fs;
  const br = new Float64Array(len), bi = new Float64Array(len);
  for (let i = 0; i < len; i++) { const v = x[start + i] || 0; br[i] = v * Math.cos(w * i); bi[i] = -v * Math.sin(w * i); }
  const box = (a) => {
    const o = new Float64Array(a.length - D + 1);
    let s = 0;
    for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= D) s -= a[i - D]; if (i >= D - 1) o[i - D + 1] = s / D; }
    return o;
  };
  const fr = box(box(box(br))), fi = box(box(box(bi)));
  const re = new Float64Array(out), im = new Float64Array(out);
  for (let k = 0; k < out; k++) { re[k] = fr[k * D]; im[k] = fi[k * D]; }
  return { re, im, rate: fs / D };
}
