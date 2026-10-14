// Wheel geometry: spoke length and where the interlaced crossing sits.
// All lengths in mm. The wheel plane is x–y; the axle is z.

function seg2Intersect(p1, p2, q1, q2) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = q2[0] - q1[0], d2y = q2[1] - q1[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const ex = q1[0] - p1[0], ey = q1[1] - p1[1];
  const s = (ex * d2y - ey * d2x) / den;
  const u = (ex * d1y - ey * d1x) / den;
  if (s <= 0 || s >= 1 || u <= 0 || u >= 1) return null;
  return { s, u };
}

// spokes: total spoke count; crosses: 0 (radial) … 4.
// flangePcd: diameter of the flange's spoke-hole circle; flangeOffset: centre
// of hub to flange; nippleLen: nipple length (the spoke leaves the nipple's
// shank about this far inside the ERD point).
export function wheelGeometry({ erd, spokes, crosses, flangePcd, flangeOffset, nippleLen = 12, holeDia = 2.6 }) {
  const R = erd / 2, r = flangePcd / 2, w = flangeOffset;
  const n = spokes / 2; // spokes on this flange
  const alpha = crosses * 2 * Math.PI / n;
  const length = Math.sqrt(R * R + r * r + w * w - 2 * R * r * Math.cos(alpha)) - holeDia / 2;
  if (crosses === 0) {
    return { length, freeLength: length - nippleLen - 3, crossFraction: null, farEnd: 'hub' };
  }
  // Leading spoke from flange hole 0 to rim; trailing spokes from every other
  // flange hole run the opposite way. The crossing nearest the rim is the
  // interlaced one, where the spokes touch.
  const hub = (th) => [r * Math.cos(th), r * Math.sin(th)];
  const rim = (th) => [R * Math.cos(th), R * Math.sin(th)];
  const a0 = hub(0), a1 = rim(alpha);
  let best = null;
  // Leading and trailing spokes alternate around the flange, so the trailing
  // spokes leave from the odd-numbered holes.
  for (let k = 1; k < n; k += 2) {
    const th = k * 2 * Math.PI / n;
    const hit = seg2Intersect(a0, a1, hub(th), rim(th - alpha));
    if (hit && (!best || hit.s > best.s)) best = hit;
  }
  if (!best) return { length, freeLength: length - nippleLen - 3, crossFraction: null, farEnd: 'hub' };
  // A straight 3-D line projects to a straight 2-D line with the same
  // parameter, so the fraction carries over to the true length.
  const fromRim = (1 - best.s) * (length + holeDia / 2);
  return { length, freeLength: fromRim - nippleLen, crossFraction: 1 - best.s, farEnd: 'cross' };
}
