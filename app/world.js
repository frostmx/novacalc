// Island geometry and building placement (no DOM). Units are the game's world units, y up.
//
// WorldGenerator: islands are flat-top hexagons of radius (12, 10) on a hex grid; neighbours sit at (0, ±10√3) and
// (±18, ±5√3). GridManager snaps placement to 0.5-unit cells: (position − placementOffset) lands on a cell centre
// in world coordinates (checked on saves). A building occupies its placementCollider box (`footprint`).

export const RX = 12;
export const RY = 10 * Math.sqrt(3) / 2; // 8.66: half the hexagon's height
const STEP_X = 18;
const STEP_Y = 10 * Math.sqrt(3);
const CELL = 0.5;
const DEFAULT_FOOTPRINT = { w: 0.9, h: 0.9, x: 0, y: 0 }; // NPCs and landmarks have no placement collider

/** Island centre for axial coordinates (q: column, r: row). */
export const hexCenter = (q, r) => ({ x: STEP_X * q, y: (STEP_Y / 2) * q + STEP_Y * r });

/** Axial coordinates of the island whose centre is nearest to a world point. */
export function hexAt(x, y) {
  // flat-top axial rounding
  const qf = x / STEP_X;
  const rf = (y - (STEP_Y / 2) * qf) / STEP_Y;
  const sf = -qf - rf;
  let q = Math.round(qf); let r = Math.round(rf); const s = Math.round(sf);
  const dq = Math.abs(q - qf); const dr = Math.abs(r - rf); const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

export const hexDistance = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;

/** Grid slots of rings 0..maxRing, centre first, then ring by ring. */
export function hexSlots(maxRing = 2) {
  const out = [];
  for (let q = -maxRing; q <= maxRing; q++) {
    for (let r = -maxRing; r <= maxRing; r++) if (hexDistance(q, r) <= maxRing) out.push({ q, r });
  }
  return out.sort((a, b) => hexDistance(a.q, a.r) - hexDistance(b.q, b.r));
}

/** Hexagon corners relative to the island centre. */
export const hexCorners = () => [[RX, 0], [RX / 2, RY], [-RX / 2, RY], [-RX, 0], [-RX / 2, -RY], [RX / 2, -RY]];

/** Is a point (relative to the island centre) on the island? */
export const insideHex = (x, y, eps = 1e-6) => Math.abs(y) <= RY + eps && Math.abs(x) <= RX - Math.abs(y) * (RX / 2) / RY + eps;

export const footprintOf = b => b?.footprint ?? DEFAULT_FOOTPRINT;

/** Footprint rectangle {x0, y0, x1, y1} of a building at position (x, y). */
export function rectAt(b, x, y) {
  const f = footprintOf(b);
  const cx = x + f.x;
  const cy = y + f.y;
  return { x0: cx - f.w / 2, y0: cy - f.h / 2, x1: cx + f.w / 2, y1: cy + f.h / 2 };
}

/**
 * Building position (relative to the island centre) for a footprint centred near (cx, cy), snapped like the game.
 * `center` is the island centre in world coordinates (the grid is global).
 */
export function snapPosition(b, center, cx, cy) {
  const f = footprintOf(b);
  const [ox, oy] = b?.placementOffset ?? [0, 0];
  const snap = (v, o) => Math.floor((v - o) / CELL) * CELL + CELL / 2 + o;
  const wx = snap(center.x + cx - f.x, ox);
  const wy = snap(center.y + cy - f.y, oy);
  return { x: wx - center.x, y: wy - center.y };
}

const overlap = (a, b) => a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6;

/** Can building `b` stand at (x, y) on an island among `others` ([{ b, x, y }])? */
export function canPlace(b, x, y, others) {
  const r = rectAt(b, x, y);
  if (![[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].every(([px, py]) => insideHex(px, py, 0.02))) return false;
  return !others.some(o => overlap(r, rectAt(o.b, o.x, o.y)));
}

// ---------- transporters ----------
// A transporter is two arms on paired shore slots of neighbouring islands (input arm → output arm).
// Every island has the same 48 slots (save: Area.TransportersSlots, positions relative to the centre), 8 per edge;
// edge e faces the neighbour at centre + 2·(edge midpoint) and slot e·8+k pairs with that neighbour's slot
// ((e+3) mod 6)·8 + (7−k) (checked on saves).
export const TRANSPORTER_SLOTS = [
  [9.8791, -1.3059], [9.3197, -2.1135], [8.7602, -2.9210], [8.2007, -3.7285], [7.6413, -4.5360], [7.0818, -5.3435], [6.5224, -6.1511], [5.9629, -6.9586],
  [4.0900, -7.8576], [2.9214, -7.8576], [1.7529, -7.8576], [0.5843, -7.8576], [-0.5843, -7.8576], [-1.7529, -7.8576], [-2.9214, -7.8576], [-4.0900, -7.8576],
  [-5.9629, -6.9586], [-6.5224, -6.1510], [-7.0818, -5.3435], [-7.6413, -4.5360], [-8.2008, -3.7285], [-8.7602, -2.9210], [-9.3197, -2.1135], [-9.8791, -1.3059],
  [-9.8791, 1.0059], [-9.3197, 1.8135], [-8.7602, 2.6210], [-8.2007, 3.4285], [-7.6413, 4.2360], [-7.0818, 5.0435], [-6.5224, 5.8510], [-5.9629, 6.6586],
  [-4.0900, 7.5576], [-2.9214, 7.5576], [-1.7529, 7.5576], [-0.5843, 7.5576], [0.5843, 7.5576], [1.7529, 7.5576], [2.9214, 7.5576], [4.0900, 7.5576],
  [5.9629, 6.6586], [6.5223, 5.8510], [7.0818, 5.0435], [7.6413, 4.2360], [8.2007, 3.4285], [8.7602, 2.6210], [9.3197, 1.8134], [9.8791, 1.0059],
];

/** Paired slot index on the neighbour across slot i's edge, and that neighbour's offset from this centre. */
export function slotPair(i) {
  const e = Math.floor(i / 8);
  const k = i % 8;
  const a = hexCorners()[(6 - e) % 6];
  const b = hexCorners()[(6 - e + 5) % 6];
  return { slot: ((e + 3) % 6) * 8 + (7 - k), dx: a[0] + b[0], dy: a[1] + b[1] };
}

/** Nearest shore slot to a point relative to the island centre: { slot, dist }. */
export function nearestSlot(x, y) {
  let best = { slot: -1, dist: Infinity };
  TRANSPORTER_SLOTS.forEach(([sx, sy], i) => {
    const d = Math.hypot(sx - x, sy - y);
    if (d < best.dist) best = { slot: i, dist: d };
  });
  return best;
}

/** Slot index whose position matches (x, y) (a transporter arm loaded from a save), or -1. */
export const slotAt = (x, y) => { const n = nearestSlot(x, y); return n.dist < 0.05 ? n.slot : -1; };
