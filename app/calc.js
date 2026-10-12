// Board math. All rates are items per minute.
//
// Production speed (verified against save files and the game code, see TODO.md):
//   speed = building.productionSpeed × (1 + skills + gem + lubricant)
//   Animal Barn: productionSpeed × (1 + bonusPerCreature × (creatures − 1)) × (1 + skills)   (no gem, no lubricant)
//   cycle = recipe.time / speed
// Output bonus skills (Agriculture): each output gets + round(amount × bonus) per cycle.
// Lubricant burns one item per `duration` seconds per building while it produces.
// Farms (per plot): growth / regrowth runs at the fertilizer multiplier (×3, not +3). Water burns one ball per
//   `ballDuration` s while the plant grows (once-crops always need it, renewable plants only if watered);
//   fertilizer burns one item per `duration` s, but only while there is water. Advanced Farm = several plots;
//   with Irrigation Efficiency each water ball counts twice there.
// Goals: a sink that wants `amount` of each item every `every` minutes/hours.
// Generators: burn one fuel item per fuelDuration × (1 + efficiency skills) s, all the time; produce
//   `producedEnergy` units (solar panels × the Solar Power multiplier, rounded). Energy is pooled per island
//   (WorldArea.AllocateEnergy): buildings need `energy` units while placed.
import { IRRIGATION_SKILL } from './data.js';

export const EPS = 1e-6;

/** Speed and its components for a node under the board's modifiers (`mods`: { skills: [id], gems: [item|null] }). */
export function speedParts(node, building, db, mods) {
  const parts = { base: building.productionSpeed ?? 1, creatures: 0, skills: 0, gem: 0, lubricant: 0, fertilizer: 0, speed: 0 };
  if (building.farm) {
    const fert = fertilizerOf(node, db);
    parts.base = 1;
    parts.fertilizer = fert?.multiplier ?? 0;
    parts.speed = fert ? fert.multiplier : 1;
    return parts;
  }
  for (const id of mods?.skills ?? []) {
    for (const x of db.skills.get(id)?.speed ?? []) if (x.building === building.id) parts.skills += x.value;
  }
  if (building.maxCreatures) {
    const n = Math.min(Math.max(node.creatures ?? 1, 1), building.maxCreatures);
    parts.creatures = (building.bonusPerCreature ?? 0) * (n - 1);
    parts.speed = parts.base * (1 + parts.creatures) * (1 + parts.skills);
    return parts;
  }
  const group = db.overclockGroupOf.get(building.id);
  if (group != null) parts.gem = db.gems.get(mods?.gems?.[group])?.speedBonus ?? 0;
  const lub = lubricantOf(node, building, db);
  if (lub) parts.lubricant = lub.multiplier;
  parts.speed = parts.base * (1 + parts.skills + parts.gem + parts.lubricant);
  return parts;
}

export const nodeSpeed = (node, building, db, mods) => speedParts(node, building, db, mods).speed;

/** The lubricant a node runs with, if its building takes lubricant. */
export function lubricantOf(node, building, db) {
  return building.lubricant && node.lub != null ? db.lubricants.get(node.lub) ?? null : null;
}

export const fertilizerOf = (node, db) => (node.fert != null ? db.fertilizers.get(node.fert) ?? null : null);

/** Whether a farm node's plants get water: once-crops always, renewable plants when the node says so. */
export function isWatered(node, crop) {
  if (!crop || crop.water.balls <= 0) return false;
  return crop.harvest.type === 'once' || !!node.water;
}

/** Fuel efficiency skills for a generator: fuel lasts (1 + bonus) times longer. */
export function efficiencyBonus(building, db, mods) {
  let bonus = 0;
  for (const id of mods?.skills ?? []) {
    for (const x of db.skills.get(id)?.efficiency ?? []) if (x.building === building.id) bonus += x.value;
  }
  return bonus;
}

/** Energy units one generator produces (solar panels get the Solar Power multiplier). */
export function generatorEnergy(building, db, mods) {
  if (building.fuel) return building.producedEnergy;
  let mult = 1;
  for (const id of mods?.skills ?? []) mult = Math.max(mult, db.skills.get(id)?.solarMultiplier || 1);
  return roundHalfEven(building.producedEnergy * mult);
}

/** Sum of output bonus skills for a building (e.g. Agriculture: +1.0 = double seeds). */
export function outputBonus(building, db, mods) {
  let bonus = 0;
  for (const id of mods?.skills ?? []) {
    for (const x of db.skills.get(id)?.extraOutput ?? []) if (x.building === building.id) bonus += x.value;
  }
  return bonus;
}

// Unity's Mathf.RoundToInt rounds halves to even.
function roundHalfEven(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export const outputAmount = (amount, bonus) => amount + (bonus ? roundHalfEven(amount * bonus) : 0);

/** Items a goal wants per minute, merged by item. */
export function goalRates(node) {
  const minutes = Math.max(node.every || 1, 1e-9) * (node.per === 'h' ? 60 : 1);
  const rates = new Map();
  for (const row of node.items ?? []) {
    if (row.item == null || !(row.amount > 0)) continue;
    rates.set(row.item, (rates.get(row.item) ?? 0) + row.amount / minutes);
  }
  return rates;
}

const near = (a, b) => a >= b - EPS * Math.max(1, Math.abs(b));

/** 'ext' — not connected, 'ok' — balanced, 'short' — input lacks supply, 'surplus' — output not fully used. */
export function portStatus(p) {
  if (!p.edges.length) return 'ext';
  if (near(p.flow, p.rate)) return 'ok';
  return p.dir === 'in' ? 'short' : 'surplus';
}

const makePort = (n, item, amount, dir, perBuilding, count, extra) => ({
  node: n.id, item, dir, amount, perBuilding, rate: perBuilding * count, flow: 0, edges: [], ...extra,
});

function addInput(inputs, n, item, perBuilding, count, flag) {
  const existing = inputs.get(item);
  if (existing) {
    existing.perBuilding += perBuilding;
    existing.rate += perBuilding * count;
    Object.assign(existing, flag);
  } else {
    inputs.set(item, makePort(n, item, null, 'in', perBuilding, count, flag));
  }
}

function generatorNode(n, b, r, db, mods) {
  const efficiency = efficiencyBonus(b, db, mods);
  const burn = b.fuel ? b.fuel.duration * (1 + efficiency) : 0;
  const inputs = new Map();
  if (b.fuel) inputs.set(b.fuel.item, makePort(n, b.fuel.item, 1, 'in', 60 / burn, n.count));
  const parts = { base: 1, creatures: 0, skills: 0, gem: 0, lubricant: 0, fertilizer: 0, efficiency, speed: 1 };
  const energyEach = generatorEnergy(b, db, mods);
  return { n, b, r, parts, speed: 1, cycle: burn, plots: 1, inputs, outputs: new Map(), gen: true, energyEach, energyMade: energyEach * n.count };
}

/** A building with no recipe picked yet: no ports, but it stands on its island and holds its energy. */
export const NO_RECIPE = Object.freeze({ id: null, inputs: [], outputs: [], time: 0 });

function productionNode(n, db, mods) {
  const b = db.buildings.get(n.b);
  if (b && n.r == null) {
    return { n, b, r: NO_RECIPE, parts: speedParts(n, b, db, mods), speed: 0, cycle: 0, plots: b.farm?.plots ?? 1, inputs: new Map(), outputs: new Map(), empty: true };
  }
  const r = db.recipes.get(n.r);
  if (!b || !r) return null;
  if (r.gen) return generatorNode(n, b, r, db, mods);
  const parts = speedParts(n, b, db, mods);
  const cycle = r.time / parts.speed;
  const plots = b.farm?.plots ?? 1;
  const runsPerBuilding = (60 / cycle) * plots;
  const bonus = outputBonus(b, db, mods);
  const inputs = new Map(r.inputs.map(s => [s.item, makePort(n, s.item, s.amount, 'in', s.amount * runsPerBuilding, n.count)]));
  const outputs = new Map(r.outputs.map(s => {
    const amount = outputAmount(s.amount, bonus);
    return [s.item, makePort(n, s.item, amount, 'out', amount * runsPerBuilding, n.count, amount !== s.amount ? { baseAmount: s.amount } : null)];
  }));
  const lub = lubricantOf(n, b, db);
  if (lub) addInput(inputs, n, lub.item, 60 / lub.duration, n.count, { lubricant: true });
  if (b.class === 'DrillerBuilding' && db.drill) addInput(inputs, n, db.drill.item, 60 / db.drill.duration, n.count, { drill: true });
  if (b.farm && r.crop) {
    const watered = isWatered(n, r.crop);
    if (watered && db.waterItem != null) {
      let per = (60 / r.crop.water.ballDuration) * plots;
      if (b.key === 'AdvancedFarmPlot' && mods?.skills?.includes(IRRIGATION_SKILL)) per /= 2;
      addInput(inputs, n, db.waterItem, per, n.count, { water: true });
    }
    const fert = fertilizerOf(n, db);
    if (fert && watered) addInput(inputs, n, fert.item, (60 / fert.duration) * plots, n.count, { fertilizer: true });
  }
  return { n, b, r, parts, speed: parts.speed, cycle, plots, inputs, outputs };
}

function goalNode(n) {
  const inputs = new Map();
  for (const [item, rate] of goalRates(n)) inputs.set(item, makePort(n, item, null, 'in', rate, 1));
  return { n, goal: true, inputs, outputs: new Map() };
}

/** Capacity of a drone route: not limited (a link carried by drones shows as such). */
export const DRONE_CAP = 1e9;

/**
 * Transporters between islands (state.placed): an input arm carrying `item` on island A with its twin on B moves up
 * to db.transporterPerMin of it per minute from A to B. cap(item, A, B) = max flow through that network (a route
 * may pass other islands; routes between different island pairs are not charged against each other).
 * Drone bases add routes from their island to their targets' islands (DRONE_CAP).
 * Only islands placed on the hex map are bound by it (`enforced`); cards without an island are not.
 */
export function transportNetwork(state, db) {
  const arcs = new Map(); // item -> [[from, to, cap]]
  const byId = new Map((state.placed ?? []).map(p => [p.id, p]));
  for (const p of state.placed ?? []) {
    if (p.b !== db.inputArmId || p.item == null) continue;
    const t = byId.get(p.twin);
    if (!t || t.g === p.g || !state.groups?.[p.g] || !state.groups?.[t.g]) continue;
    (arcs.get(p.item) ?? arcs.set(p.item, []).get(p.item)).push([p.g, t.g, db.transporterPerMin]);
  }
  // drone bases carry their item to target containers on other islands; their rate is not limited here
  for (const p of state.placed ?? []) {
    if (p.b !== db.droneBaseId || p.item == null || !state.groups?.[p.g]) continue;
    for (const id of p.targets ?? []) {
      const t = byId.get(id);
      if (t && t.g !== p.g && state.groups?.[t.g]) (arcs.get(p.item) ?? arcs.set(p.item, []).get(p.item)).push([p.g, t.g, DRONE_CAP]);
    }
  }
  const cache = new Map();
  function cap(item, a, b) {
    const key = `${item}|${a}|${b}`;
    if (!cache.has(key)) cache.set(key, maxFlow(arcs.get(item) ?? [], a, b));
    return cache.get(key);
  }
  const enforced = (a, b) => !!a && !!b && a !== b && state.groups?.[a]?.q != null && state.groups?.[b]?.q != null;
  return { cap, enforced, arcs };
}

/** Edmonds–Karp on a tiny graph given as [[from, to, cap]]. */
function maxFlow(list, s, t) {
  const res = new Map();
  const adj = new Map();
  const link = (u, v) => (adj.get(u) ?? adj.set(u, new Set()).get(u)).add(v);
  for (const [u, v, c] of list) {
    res.set(`${u}>${v}`, (res.get(`${u}>${v}`) ?? 0) + c);
    if (!res.has(`${v}>${u}`)) res.set(`${v}>${u}`, 0);
    link(u, v);
    link(v, u);
  }
  let flow = 0;
  for (;;) {
    const prev = new Map([[s, null]]);
    const queue = [s];
    while (queue.length && !prev.has(t)) {
      const u = queue.shift();
      for (const v of adj.get(u) ?? []) {
        if (!prev.has(v) && res.get(`${u}>${v}`) > EPS) { prev.set(v, u); queue.push(v); }
      }
    }
    if (!prev.has(t)) return flow;
    let bottleneck = Infinity;
    for (let v = t; prev.get(v) != null; v = prev.get(v)) bottleneck = Math.min(bottleneck, res.get(`${prev.get(v)}>${v}`));
    for (let v = t; prev.get(v) != null; v = prev.get(v)) {
      const u = prev.get(v);
      res.set(`${u}>${v}`, res.get(`${u}>${v}`) - bottleneck);
      res.set(`${v}>${u}`, res.get(`${v}>${u}`) + bottleneck);
    }
    flow += bottleneck;
  }
}

export function compute(state, db) {
  const mods = state.mods;
  const nodes = new Map();
  for (const n of state.nodes) {
    const c = n.kind === 'goal' ? goalNode(n) : productionNode(n, db, mods);
    if (c) nodes.set(n.id, c);
  }

  const net = transportNetwork(state, db);
  const carried = new Map(); // transport key -> flow already routed
  const room = ce => (ce.transport ? ce.transport.cap - (carried.get(ce.transport.key) ?? 0) : Infinity);
  const edges = [];
  for (const e of state.edges) {
    const src = nodes.get(e.from[0])?.outputs.get(e.from[1]);
    const dst = nodes.get(e.to[0])?.inputs.get(e.to[1]);
    if (!src || !dst || e.from[0] === e.to[0]) continue;
    const ce = { e, src, dst, flow: 0 };
    // between islands the transporters carrying this item limit the flow
    const ga = nodes.get(e.from[0]).n.g;
    const gb = nodes.get(e.to[0]).n.g;
    if (net.enforced(ga, gb)) ce.transport = { key: `${e.from[1]}|${ga}|${gb}`, cap: net.cap(e.from[1], ga, gb) };
    src.edges.push(ce);
    dst.edges.push(ce);
    edges.push(ce);
  }

  // Flow allocation: inputs ask their suppliers for the missing amount (split evenly between suppliers that still
  // have stock), suppliers grant it proportionally to what they have left. A few rounds let other suppliers cover
  // what an exhausted one could not.
  const ins = [...nodes.values()].flatMap(c => [...c.inputs.values()]);
  const outs = [...nodes.values()].flatMap(c => [...c.outputs.values()]);
  for (let round = 0; round < 8; round++) {
    const asks = new Map();
    for (const p of ins) {
      const deficit = p.rate - p.flow;
      if (deficit <= EPS) continue;
      const open = p.edges.filter(ce => ce.src.rate - ce.src.flow > EPS && room(ce) > EPS);
      for (const ce of open) asks.set(ce, (asks.get(ce) ?? 0) + deficit / open.length);
    }
    if (!asks.size) break;
    for (const q of outs) {
      const mine = q.edges.filter(ce => asks.has(ce));
      if (!mine.length) continue;
      const total = mine.reduce((s, ce) => s + asks.get(ce), 0);
      const k = Math.min(1, (q.rate - q.flow) / total);
      for (const ce of mine) {
        const f = Math.min(asks.get(ce) * k, room(ce));
        if (ce.transport) carried.set(ce.transport.key, (carried.get(ce.transport.key) ?? 0) + f);
        ce.flow += f;
        q.flow += f;
        ce.dst.flow += f;
      }
    }
  }

  // Per-node input coverage (connected inputs only) and board totals.
  const items = new Map();
  const total = id => items.get(id) ?? items.set(id, { item: id, produced: 0, consumed: 0 }).get(id);
  let energy = 0;
  let energyMade = 0;
  let buildingCount = 0;
  const energyByGroup = new Map(); // island -> { used, made }
  for (const c of nodes.values()) {
    const linked = [...c.inputs.values()].filter(p => p.edges.length);
    c.coverage = linked.length ? Math.min(...linked.map(p => (p.rate > 0 ? p.flow / p.rate : 1))) : 1;
    for (const p of c.inputs.values()) total(p.item).consumed += p.rate;
    for (const p of c.outputs.values()) total(p.item).produced += p.rate;
    if (c.goal) continue;
    const used = (c.b.energy ?? 0) * c.n.count;
    const made = c.energyMade ?? 0;
    energy += used;
    energyMade += made;
    buildingCount += c.n.count;
    if (c.n.g) {
      const e = energyByGroup.get(c.n.g) ?? energyByGroup.set(c.n.g, { used: 0, made: 0 }).get(c.n.g);
      e.used += used;
      e.made += made;
    }
  }
  for (const it of items.values()) it.net = it.produced - it.consumed;

  return { nodes, edges, items, energy, energyMade, energyByGroup, buildingCount, net };
}
