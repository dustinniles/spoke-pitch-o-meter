// Spoke catalogue.
//
// Diameters in mm: dThread (thread end), mid (thin middle), dHead (head end).
// Bladed spokes give the blade thickness `t` and either the source round wire
// `d0` they are forged from (mass is conserved, so this fixes the mass) or a
// nominal width `w`.
//
// threadButt: length of full-thickness wire left outside the nipple before the
// taper starts. Nobody publishes butt lengths; DT's published weights imply
// 40–70 mm of thick wire per spoke in total, most of it at the head, and the
// thread-end section typically ends a few mm past the threads. 5 mm is the
// default; the reading changes by under 1 % anywhere from 3 to 20 mm.
//
// massFactor: DT's own weights for plain-gauge Champion spokes (444 g and
// 359 g per 64 at 264 mm, for 2.0 and 1.8 mm) are 3.4–3.6 % above nominal
// wire at 7.92 g/cm³ after allowing ~0.13 g for the head. Sapim's calculator
// data for the Leader agrees (+4 %). Real wire runs a little oversize, so all
// steel spokes get ×1.035.
//
// Sources: dtswiss.com spoke pages; Sapim spoke-calculator data
// (app.spokecalc.io); Pillar 2026 catalogue; retailer listings where noted.

const STEEL = { material: 'steel', massFactor: 1.035, threadButt: 5, headButt: 40, taper: 8 };

const round = (id, maker, name, profile, dHead, mid, dThread, extra = {}) =>
  ({ ...STEEL, id, maker, name, profile, dHead, dThread, mid: { d: mid }, ...extra });
const blade = (id, maker, name, profile, t, d0, extra = {}) =>
  ({ ...STEEL, id, maker, name, profile, dHead: 2.0, dThread: 2.0, mid: { t, d0 }, threadButt: 8, taper: 10, note: 'Pluck across the flat face of the blade.', ...extra });

export const SPOKES = [
  round('dt-champion-20', 'DT Swiss', 'Champion', '2.0', 2.0, 2.0, 2.0, { threadButt: 0 }),
  round('dt-champion-18', 'DT Swiss', 'Champion', '1.8', 1.8, 1.8, 1.8, { threadButt: 0 }),
  round('dt-competition', 'DT Swiss', 'Competition', '2.0/1.8/2.0', 2.0, 1.8, 2.0),
  round('dt-competition-race', 'DT Swiss', 'Competition Race', '2.0/1.6/2.0', 2.0, 1.6, 2.0),
  round('dt-revolution', 'DT Swiss', 'Revolution', '2.0/1.5/2.0', 2.0, 1.5, 2.0),
  round('dt-supercomp', 'DT Swiss', 'Super Comp', '2.0/1.7/1.8', 2.0, 1.7, 1.8, { note: 'DT lists 2.0/1.7/1.8; the 1.8 is taken to be the thread end.' }),
  round('dt-alpine', 'DT Swiss', 'Alpine III', '2.34/1.8/2.0', 2.34, 1.8, 2.0),
  blade('dt-aerolite', 'DT Swiss', 'Aerolite', '2.0/2.3×0.9/2.0', 0.9, 1.5),
  blade('dt-aerocomp', 'DT Swiss', 'Aero Comp', '2.0/2.3×1.2/2.0', 1.2, 1.8),
  blade('dt-revolite', 'DT Swiss', 'Revolite', '2.0/2.3×1.3/2.0', 1.3, 1.57, { note: 'Pluck across the flat face. DT’s blade dimensions for this spoke are inconsistent; mass is taken from its 1.57 mm source wire.' }),
  blade('dt-complite', 'DT Swiss', 'Complite', '2.0/2.3×1.5/2.0', 1.5, 1.75, { note: 'Pluck across the flat face. DT’s blade dimensions for this spoke are inconsistent; mass is taken from its 1.75 mm source wire.' }),

  round('sapim-leader', 'Sapim', 'Leader', '2.0', 2.0, 2.0, 2.0, { threadButt: 0 }),
  round('sapim-race', 'Sapim', 'Race', '2.0/1.8/2.0', 2.0, 1.8, 2.0),
  round('sapim-dlight', 'Sapim', 'D-Light', '2.0/1.65/2.0', 2.0, 1.65, 2.0, { threadButt: 1, note: 'Sapim keeps the thread-end 2.0 section deliberately short.' }),
  round('sapim-laser', 'Sapim', 'Laser', '2.0/1.5/2.0', 2.0, 1.5, 2.0),
  round('sapim-force', 'Sapim', 'Force', '2.2/1.8/2.0', 2.2, 1.8, 2.0),
  round('sapim-strong', 'Sapim', 'Strong', '2.3/2.0', 2.3, 2.0, 2.0, { threadButt: 0 }),
  blade('sapim-cxray', 'Sapim', 'CX-Ray', '2.0/2.2×0.9/2.0', 0.9, 1.4385),
  blade('sapim-cxsprint', 'Sapim', 'CX-Sprint', '2.0/2.25×1.25/2.0', 1.25, 1.68),

  round('pillar-1415', 'Pillar', 'PDB 1415', '2.0/1.8/2.0', 2.0, 1.8, 2.0),
  round('pillar-1417', 'Pillar', 'PDB 1417', '2.0/1.5/2.0', 2.0, 1.5, 2.0),
  round('pillar-tb2015', 'Pillar', 'PSR TB 2015', '2.2/2.0/1.5/2.0', 2.2, 1.5, 2.0),
  round('pillar-tb2016', 'Pillar', 'PSR TB 2016', '2.2/2.0/1.6/2.0', 2.2, 1.6, 2.0),

  round('wheelsmith-db14', 'Wheelsmith', 'DB14', '2.0/1.7/2.0', 2.0, 1.7, 2.0),
  round('wheelsmith-xl14', 'Wheelsmith', 'XL14', '2.0/1.5/2.0', 2.0, 1.5, 2.0),

  round('plain-23', 'Plain gauge', 'Plain', '2.3 (13 g)', 2.3, 2.3, 2.3, { threadButt: 0 }),
  round('plain-20', 'Plain gauge', 'Plain', '2.0 (14 g)', 2.0, 2.0, 2.0, { threadButt: 0 }),
  round('plain-18', 'Plain gauge', 'Plain', '1.8 (15 g)', 1.8, 1.8, 1.8, { threadButt: 0 }),
];

export function spokeById(id) { return SPOKES.find((s) => s.id === id) ?? SPOKES.find((s) => s.id === 'dt-competition'); }
export function spokeLabel(s) { return s.maker === 'Plain gauge' ? `Plain gauge ${s.profile}` : `${s.maker} ${s.name} ${s.profile}`; }
