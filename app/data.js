// Game data access: loads data/gamedata.json and builds lookup tables for the calculator.
import { t, plain } from './i18n.js';

// "IronIngotResource" -> "Iron Ingot": last-resort label when a localization key is missing.
const humanize = key => key.replace(/(Resource|Building|Prop|Creature|Biome)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim();

// A recipe is usable on the board when it actually produces something over time.
const usable = r => r && r.outputs.length > 0 && r.time > 0;

// Advanced Farm: every water ball counts twice once this research is done (AdvancedFarmPlotBuilding.duplicateWaterBalls).
export const IRRIGATION_SKILL = 454;
// non-production buildings the architect offers in its catalog (transporter, storage, logistics, oxygen)
const INFRA_KEYS = ['TransporterContainerInput', 'Deposit', 'Container', 'BotAntenna', 'DroneBase', 'OxygenBeacon', 'Oxygenator'];

const avg = ([a, b]) => (a + b) / 2;

/**
 * A crop as a recipe for farm buildings, per plot. `once` crops eat a seed per harvest; renewable plants are planted
 * once and then give `items` every `interval` (harvested right away, so charges never pile up).
 * Fertilizer speeds both up; water and fertilizer burn on top (see calc.js).
 */
function cropRecipe(crop) {
  const h = crop.harvest;
  if (h.type === 'once') {
    return { id: `crop:${crop.seed}`, crop, inputs: [{ item: crop.seed, amount: 1 }], outputs: [{ item: h.item, amount: avg(h.perHarvest) }], time: crop.growthTime };
  }
  const amount = h.burst ? avg(h.itemsPerHarvest) : Math.min(h.chargesPerInterval, h.maxCharges);
  return { id: `crop:${crop.seed}`, crop, inputs: [], outputs: [{ item: h.item, amount }], time: h.interval };
}

/** A generator as a recipe: burns one fuel item per `fuel.duration` s (no item output; energy is separate). */
function generatorRecipe(b) {
  return { id: `gen:${b.id}`, gen: true, inputs: b.fuel ? [{ item: b.fuel.item, amount: 1 }] : [], outputs: [], time: b.fuel?.duration ?? 60 };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export async function loadData() {
  const [g, icons] = await Promise.all([
    fetchJson('../data/gamedata.json'),
    fetchJson('../data/icons.json').catch(() => null), // icons are optional
  ]);

  const items = new Map(g.items.map(i => [i.id, i]));
  const recipes = new Map(g.recipes.map(r => [r.id, r]));
  const buildings = new Map(g.buildings.map(b => [b.id, b]));
  const creatures = new Map(g.creatures.map(c => [c.key, c]));
  for (const c of g.crops) recipes.set(`crop:${c.seed}`, cropRecipe(c));
  for (const b of g.buildings) if (b.producedEnergy) recipes.set(`gen:${b.id}`, generatorRecipe(b));

  // An entry is one thing a building can run: a recipe, a creature's recipe (Animal Barn) or a crop (farms).
  const entries = [];
  for (const b of g.buildings) {
    if (b.maxCreatures) {
      for (const c of g.creatures) {
        for (const rid of c.recipes) if (usable(recipes.get(rid))) entries.push({ b, r: recipes.get(rid), creature: c });
      }
    } else if (b.farm) {
      for (const c of g.crops) entries.push({ b, r: recipes.get(`crop:${c.seed}`) });
    } else if (b.producedEnergy) {
      entries.push({ b, r: recipes.get(`gen:${b.id}`) });
    } else {
      for (const rid of b.recipes ?? []) if (usable(recipes.get(rid))) entries.push({ b, r: recipes.get(rid) });
    }
  }

  const group = (keyOf) => {
    const m = new Map();
    for (const e of entries) for (const k of keyOf(e)) (m.get(k) ?? m.set(k, []).get(k)).push(e);
    return m;
  };
  const entriesByBuilding = group(e => [e.b.id]);
  const producers = group(e => e.r.outputs.map(s => s.item));
  const consumers = group(e => e.r.inputs.map(s => s.item));

  function itemName(id) {
    const it = items.get(id);
    if (!it) return `#${id}`;
    if (it.packageOf != null) return `${itemName(it.packageOf)} ${plain(t('PackageResourceSuffix')) ?? ''}`.trim();
    return plain(t(it.nameKey)) || humanize(it.key);
  }
  const buildingName = b => plain(t(b.nameKey)) || humanize(b.key);
  const creatureName = c => plain(t(c.nameKey)) || humanize(c.key);
  const plantName = crop => plain(t(crop.plantNameKey)) || humanize(crop.plant ?? '');
  const biomeName = biome => plain(t(`${biome}_NAME`)) || humanize(biome);
  const fmtAmount = a => String(Math.round(a * 100) / 100);

  function entryLabel(e) {
    const out = e.r.outputs.map(s => (s.amount !== 1 ? `${itemName(s.item)} ×${fmtAmount(s.amount)}` : itemName(s.item))).join(', ');
    if (e.creature) return `${creatureName(e.creature)} → ${out}`;
    if (e.r.crop) return `${plantName(e.r.crop)} → ${out}`;
    if (e.r.gen) return plain(t('UI_GEN_LABEL', e.b.producedEnergy)) ?? `+${e.b.producedEnergy}`;
    return out;
  }
  const stackText = list => list.map(s => `${fmtAmount(s.amount)} ${itemName(s.item)}`).join(' + ');

  const productionBuildings = [...entriesByBuilding.keys()]
    .map(id => buildings.get(id))
    .sort((a, b) => buildingName(a).localeCompare(buildingName(b)));

  // --- modifiers ---
  const m = g.modifiers;
  const skills = new Map(m.skills.map(s => [s.id, s]));
  const gems = new Map(m.overclockGems.map(x => [x.item, x]));
  const lubricants = new Map(m.lubricants.map(x => [x.item, x]));
  const fertilizers = new Map(m.fertilizers.map(x => [x.item, x]));
  const overclockGroups = m.overclockGroups;
  const overclockGroupOf = new Map();
  overclockGroups.forEach((grp, i) => grp.forEach(bid => overclockGroupOf.set(bid, i)));
  // skills that change speed, output, fuel use or water use of buildings the calculator knows
  const productionSkills = m.skills.filter(s => s.id === IRRIGATION_SKILL || s.solarMultiplier > 0
    || [...s.speed, ...s.extraOutput, ...s.efficiency].some(x => entriesByBuilding.has(x.building)));
  const gemBuildingId = g.buildings.find(b => b.key === 'GemOverclockBuilding')?.id;
  // Driller: a drill bit lasts `duration` s of drilling (DrillerBuilding.ConsumeDrill); what it can mine depends on the island
  const drill = m.drills?.[0] ?? null;
  const drillBiomes = g.drillBiomes ?? {};
  const drillIslands = item => Object.keys(drillBiomes).filter(k => drillBiomes[k].includes(item));

  const skillName = s => plain(t(s.nameKey)) || humanize(s.key);
  const skillDesc = s => plain(t(s.descKey, ...(s.descValues ?? []).map(fmtAmount))) || '';

  // --- goals: delivery points that take items and make nothing (Black Hole Pyramid, Nova Gateway, quests) ---
  const goalPresets = [];
  const seenGoal = new Set();
  for (const b of g.buildings) {
    if (b.farm) continue;
    const sinks = (b.recipes ?? []).map(id => recipes.get(id)).filter(r => r && r.inputs.length && !r.outputs.length);
    sinks.forEach((r, i) => {
      if (seenGoal.has(r.id)) return;
      seenGoal.add(r.id);
      goalPresets.push({ id: r.id, b, stage: sinks.length > 1 ? i + 1 : null, items: r.inputs.map(s => ({ item: s.item, amount: s.amount })) });
    });
  }
  const goalLabel = p => (p.stage ? `${buildingName(p.b)} · ${p.stage}` : buildingName(p.b));

  const itemsByName = [...items.values()].sort((a, b) => itemName(a.id).localeCompare(itemName(b.id)));

  // --- architect: island colours, biomes for new islands, placeable non-production buildings ---
  const biomeColors = g.biomeColors ?? {};
  const biomes = Object.keys(biomeColors).sort((a, b) => biomeName(a).localeCompare(biomeName(b)));
  const infraBuildings = INFRA_KEYS.map(k => g.buildings.find(b => b.key === k)).filter(Boolean);
  // transporters: items per minute one carries (perRound per transportDuration while it has items; measured
  // in game: 20 items in 20 s), the two arm buildings
  const tr = g.constants?.transporter;
  const transporterPerMin = tr ? (60 * tr.perRound) / Math.max(tr.duration, tr.tryInterval) : 0;
  const inputArmId = g.buildings.find(b => b.key === 'TransporterContainerInput')?.id;
  const outputArmId = g.buildings.find(b => b.key === 'TransporterContainerOutput')?.id;
  // logistics that carry one chosen item: drone base (to its target containers, any island), item antenna (to the
  // buildings of its island); magnetoids belong to the island's Magnetoid Antenna
  const keyId = key => g.buildings.find(b => b.key === key)?.id;
  const droneBaseId = keyId('DroneBase');
  const itemAntennaId = keyId('TransporterAntenna');
  const magnetAntennaId = keyId('MagnetoidAntenna');
  // DroneBase.targetContainers is a List<DepositAreaContainer>: deposits, drone bases, item antennas, export rockets
  const DRONE_TARGET_CLASSES = new Set(['DepositAreaContainer', 'DroneBase', 'TransporterAntenna', 'ExportRocketBuilding']);
  const droneTarget = b => DRONE_TARGET_CLASSES.has(b?.class);
  // props on the islands (rocks, bushes, trees, ores): collider box and what they drop
  const props = new Map((g.props ?? []).map(p => [p.id, p]));
  const propName = p => (p?.loot?.length ? p.loot.map(itemName).join(', ') : p?.key ?? '');

  // sprite atlas: index of an item's / building's cell, or null
  const icon = (kind, id) => icons?.[kind]?.[id] ?? null;

  return {
    icons, icon,
    skills, gems, lubricants, fertilizers, overclockGroups, overclockGroupOf, productionSkills, gemBuildingId,
    drill, drillBiomes, drillIslands, biomeColors, biomes, infraBuildings, transporterPerMin, inputArmId, outputArmId,
    props, propName, droneBaseId, itemAntennaId, magnetAntennaId, droneTarget,
    skillName, skillDesc, waterItem: g.constants?.waterBall, goalPresets, goalLabel, itemsByName,
    items, recipes, buildings, creatures, entries, entriesByBuilding, productionBuildings,
    producersOf: id => producers.get(id) ?? [],
    consumersOf: id => consumers.get(id) ?? [],
    findEntry: (bId, rId, creatureKey) =>
      (entriesByBuilding.get(bId) ?? []).find(e => e.r.id === rId && (e.creature?.key ?? null) === (creatureKey ?? null)),
    itemName, buildingName, creatureName, plantName, biomeName, entryLabel, stackText, fmtAmount,
  };
}
