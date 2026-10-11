import { loadLocale, tk, applyStaticTexts } from './i18n.js';
import { loadData } from './data.js';
import { compute, nodeSpeed, portStatus, outputAmount, outputBonus, isWatered, EPS, DRONE_CAP } from './calc.js';
import { decodeSave, readProfile, readFactory, readLayout } from './save.js';
import { hexAt, hexCenter, hexSlots, TRANSPORTER_SLOTS, slotPair, slotAt, footprintOf, magnetPair } from './world.js';
import { createArch } from './arch.js';
import { readTree, writeTree, applyLayout, editableBuilding } from './savewrite.js';

const STORAGE_KEY = 'novacalc.board.v1';
const SAVE_KEY = 'novacalc.save.v1'; // the imported save file itself ({ file, text }), for writing it back
const UNIT_FACTOR = { s: 1 / 60, min: 1, h: 60 };
const NODE_W = 300;
const GAP_X = 90;
const ZOOM_MIN = 0.08;
const ZOOM_MAX = 2;

const $ = id => document.getElementById(id);
const el = {
  viewport: $('viewport'), world: $('world'), nodes: $('nodes'), frames: $('frames'), edgeLayer: $('edge-layer'),
  temp: $('temp-edge'), catalog: $('catalog'), search: $('search'), summary: $('summary-body'), menu: $('menu'),
  unit: $('unit'), hint: $('hint'),
  arch: $('arch'), archHexes: $('arch-hexes'), archLabels: $('arch-labels'), archBlds: $('arch-blds'),
  archLinks: $('arch-links'), archCard: $('arch-card'),
  modeCalc: $('mode-calc'), modeArch: $('mode-arch'), viewIslands: $('view-islands'), viewChain: $('view-chain'),
  boardTools: $('board-tools'), saveOut: $('btn-save-out'),
};

let db;
let state;
let calc;
let selection = null; // { kind: 'node' | 'edge', id }
let drag = null;      // current pointer interaction
let nextId = 1;
let overlayFrame = 0;
let archView; // architect mode (arch.js)
let archNeedsFit = false; // no architect view saved yet: fit the islands when it opens

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const parseRecipeId = v => (/^-?\d+$/.test(v) ? +v : v); // farm crops use string ids ("crop:<seed>")

function fmtNum(v) {
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
const fmtRate = perMin => fmtNum(perMin * UNIT_FACTOR[state.unit]);
const unitLabel = () => tk(`UI_UNIT_${state.unit.toUpperCase()}`);
const pct = v => `${fmtNum(v * 100)}%`;

/** Icon from the sprite atlas (data/icons.png), `kind` = 'items' | 'buildings'. Empty when there is none. */
function iconHtml(kind, id, size = 20) {
  const i = db.icon(kind, id);
  if (i == null) return '';
  const { cols } = db.icons;
  return `<i class="ico" style="width:${size}px;height:${size}px;background-size:${cols * size}px auto;background-position:-${(i % cols) * size}px -${Math.floor(i / cols) * size}px"></i>`;
}
function fmtTime(sec) {
  if (sec < 60) return tk('UI_SECONDS', fmtNum(sec));
  const m = Math.floor(sec / 60);
  return tk('UI_MIN_SEC', m, fmtNum(sec - m * 60));
}

// ---------- state ----------
// Node kinds: production { b, r, count, c?, creatures?, lub? }, farm { b, r: 'crop:<seed>', count, fert?, water? },
// goal { kind: 'goal', items: [{ item, amount }], every, per: 'min' | 'h', preset? }. Any node may have g (island).
// groups[g] = island { title, biome, q?, r? (hex slot in the architect), locked?, frame? ({x, y} on the board) }.
// placed = buildings standing on islands { id, b, g, x, y (relative to the island centre, world units), node? }:
// with `node` an instance of that card (at most node.count of them), without it non-production (storage, …).
// Transporter arms also have `slot` (shore slot index) and `twin` (the placed id of the arm on the facing island);
// the input arm keeps the carried `item`. Buildings from a save keep its id as `uid`; `fixed` ones (NPCs, shops,
// landmarks, anything on a premade island) cannot be moved or deleted.
// props = rocks, bushes, trees of a save { id, uid, b (prop id), g, x, y }; they can be moved, buildings can't cover them.
// Drone bases and item antennas keep their `item` too; a drone base has `targets` (placed ids of containers, any island).
// magnets = magnetoids { id, uid?, from, to (placed ids, same island), fs, ts (their slot indices) }: items go from → to.
// saveInfo = the imported save { file, name, day, hash, types (building ids it has a record of) }: with it the
// architect's layout can be written back into that save (savewrite.js).

const emptyMods = () => ({ skills: [], gems: [] });
const emptyState = () => ({
  version: 1, unit: 'min', view: { x: 40, y: 40, z: 1 }, nodes: [], edges: [], mods: emptyMods(), groups: {},
  mode: 'calc', archView: null, placed: [], props: [], magnets: [], saveInfo: null,
  // calculator view: cards grouped in island frames, or one chain; each keeps its own card positions
  boardView: 'islands', layouts: {},
});
const isBoard = s => s && Array.isArray(s.nodes) && Array.isArray(s.edges) && s.view && typeof s.view.z === 'number';
const isGoal = n => n.kind === 'goal';

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isBoard(s)) return s;
  } catch { /* storage unavailable or corrupt: start empty */ }
  return null;
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* best effort */ }
}

function setState(s) {
  state = { ...emptyState(), ...s };
  state.mods = { ...emptyMods(), ...state.mods };
  state.groups = state.groups ?? {};
  state.placed = Array.isArray(state.placed) ? state.placed.filter(p => db.buildings.has(p.b)) : [];
  state.props = Array.isArray(state.props) ? state.props.filter(p => db.props.has(p.b)) : [];
  state.magnets = Array.isArray(state.magnets) ? state.magnets : [];
  if (state.saveInfo && storedSave()?.hash !== state.saveInfo.hash) state.saveInfo = null; // that save is gone
  if (!state.archView) { state.archView = { x: 40, y: 40, z: 0.3 }; archNeedsFit = true; }
  // drop nodes whose building/recipe no longer exist in the data
  state.nodes = state.nodes.filter(n => isGoal(n) || (db.buildings.has(n.b) && db.recipes.has(n.r)));
  const ids = [...state.nodes, ...state.edges, ...state.placed, ...state.props, ...state.magnets, ...Object.keys(state.groups).map(id => ({ id }))]
    .map(x => parseInt(String(x.id).slice(1), 10)).filter(Number.isFinite);
  nextId = (ids.length ? Math.max(...ids) : 0) + 1;
  pruneEdges();
}

const newId = prefix => `${prefix}${nextId++}`;
const findNode = id => state.nodes.find(n => n.id === id);

function commit() {
  syncPlaced();
  save();
  render();
  if (state.mode === 'arch') renderCatalog(); // "Not placed" follows every change
}

const curView = () => (state.mode === 'arch' ? state.archView : state.view);

/** Remove edges whose ports no longer exist (recipe, lubricant or fertilizer changed) and duplicates. */
function pruneEdges() {
  const valid = new Set(compute(state, db).edges.map(ce => ce.e));
  const seen = new Set();
  state.edges = state.edges.filter(e => {
    if (!valid.has(e)) return false;
    const key = `${e.from}|${e.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- rendering ----------

function render() {
  calc = compute(state, db);
  const arch = state.mode === 'arch';
  el.world.hidden = arch;
  el.arch.hidden = !arch;
  el.viewport.classList.toggle('arch-mode', arch);
  el.modeCalc.classList.toggle('active', !arch);
  el.modeArch.classList.toggle('active', arch);
  el.boardTools.hidden = arch;
  el.viewIslands.classList.toggle('active', state.boardView !== 'chain');
  el.viewChain.classList.toggle('active', state.boardView === 'chain');
  applyView();
  el.unit.value = state.unit;
  if (arch) {
    archView.render();
  } else {
    el.archCard.hidden = true;
    renderNodes();
    renderOverlay();
  }
  renderSummary();
  renderModsButton();
  el.saveOut.hidden = !state.saveInfo;
  if (state.saveInfo) el.saveOut.title = tk('UI_SAVE_OUT_TITLE', state.saveInfo.file);
  el.hint.textContent = tk(arch ? 'UI_ARCH_HINT' : 'UI_EMPTY_HINT');
  el.hint.hidden = arch ? Object.values(state.groups).some(g => g.q != null) : state.nodes.length > 0;
}

function applyView() {
  const { x, y, z } = curView();
  const layer = state.mode === 'arch' ? el.arch : el.world;
  layer.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  layer.style.setProperty('--z', z); // lets highlights keep a constant on-screen width
  el.viewport.style.backgroundSize = `${24 * z}px ${24 * z}px`;
  el.viewport.style.backgroundPosition = `${x}px ${y}px`;
  if (state.mode === 'arch') archView?.placeCard();
}

function renderNodes() {
  el.nodes.innerHTML = state.nodes.map(n => (isGoal(n) ? goalHtml(n) : nodeHtml(n))).join('');
  applyItemHighlight();
}

// Hovering an item in the summary highlights the cards that make it (hl-out) or use it (hl-in), their ports and edges.
let hoverItem = null;

function applyItemHighlight() {
  const item = hoverItem;
  if (state.mode === 'arch') { archView.applyHighlight(item); return; }
  el.nodes.classList.toggle('hl', item != null);
  for (const nodeEl of el.nodes.querySelectorAll('.node')) {
    const c = calc?.nodes.get(nodeEl.dataset.node);
    nodeEl.classList.toggle('hl-out', item != null && !!c?.outputs.has(item));
    nodeEl.classList.toggle('hl-in', item != null && !!c?.inputs.has(item));
  }
  for (const row of el.nodes.querySelectorAll('.prow')) {
    row.classList.toggle('hl', item != null && Number(row.querySelector('.port')?.dataset.item) === item);
  }
  el.edgeLayer.classList.toggle('hl', item != null);
  for (const g of el.edgeLayer.querySelectorAll('.edge')) g.classList.toggle('hl', item != null && Number(g.dataset.item) === item);
}

function setHoverItem(item) {
  if (item === hoverItem) return;
  hoverItem = item;
  applyItemHighlight();
}

const selectedCls = n => (selection?.kind === 'node' && selection.id === n.id ? ' selected' : '');
const portsHtml = (map, dir) => (map.size ? `<div class="ports ${dir}">${[...map.values()].map(portHtml).join('')}</div>` : '');
const coverageHtml = c => (c.coverage < 1 - EPS ? `<div class="warn">${esc(tk('UI_COVERAGE', Math.floor(c.coverage * 100)))}</div>` : '');

function optionList(pairs, current) {
  return pairs.map(([value, label]) => `<option value="${value}"${String(value) === String(current ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

function nodeHtml(n) {
  const c = calc.nodes.get(n.id);
  if (!c) return '';
  const { b, r } = c;
  const options = (db.entriesByBuilding.get(b.id) ?? []).map(e => {
    const value = `${e.r.id}|${e.creature?.key ?? ''}`;
    const isSel = e.r.id === n.r && (e.creature?.key ?? '') === (n.c ?? '');
    return `<option value="${esc(value)}"${isSel ? ' selected' : ''}>${esc(db.entryLabel(e))}</option>`;
  }).join('');
  const energy = b.energy ? `<span title="${esc(tk('UI_ENERGY'))}">⚡ ${fmtNum(b.energy * n.count)}</span>` : '';
  const plots = c.plots > 1 ? `<span>${esc(tk('UI_PLOTS', c.plots * n.count))}</span>` : '';
  const island = state.boardView === 'chain' && n.g && state.groups[n.g] ? `<span class="island-tag">${esc(state.groups[n.g].title)}</span>` : '';
  let extras = '';
  if (b.maxCreatures) {
    extras += `<label class="opt">${esc(tk('UI_CREATURES'))}<select data-act="creatures">${optionList(
      Array.from({ length: b.maxCreatures }, (_, i) => [i + 1, i + 1]), n.creatures ?? 1)}</select></label>`;
  }
  if (b.lubricant) {
    extras += `<label class="opt">${esc(tk('UI_LUBRICANT'))}<select data-act="lub">${optionList(
      [['', tk('UI_NONE')], ...[...db.lubricants.values()].map(l => [l.item, `${db.itemName(l.item)} (×${fmtNum(l.multiplier)})`])], n.lub)}</select></label>`;
  }
  if (b.farm) {
    extras += `<label class="opt">${esc(tk('UI_FERTILIZER'))}<select data-act="fert">${optionList(
      [['', tk('UI_NONE')], ...[...db.fertilizers.values()].map(f => [f.item, `${db.itemName(f.item)} (×${fmtNum(f.multiplier)})`])], n.fert)}</select></label>`;
    if (r.crop && r.crop.harvest.type !== 'once' && r.crop.water.balls > 0) {
      extras += `<label class="opt" title="${esc(tk('UI_WATERED_TITLE'))}"><input type="checkbox" data-act="water"${n.water ? ' checked' : ''}> ${esc(tk('UI_WATERED'))}</label>`;
    }
  }
  let cycleTitle = '';
  if (b.class === 'DrillerBuilding') {
    // what the driller can mine depends on the island (WorldBiome.drillerExtractableResources)
    const item = r.outputs[0]?.item;
    const biomes = item != null ? db.drillIslands(item) : [];
    const here = state.groups?.[n.g]?.biome;
    const wrong = here && !biomes.includes(here);
    extras += `<div class="opt${wrong ? ' warn' : ''}"${wrong ? ` title="${esc(tk('UI_DRILL_WRONG_ISLAND', db.biomeName(here)))}"` : ''}>${
      esc(tk('UI_DRILL_ISLANDS', biomes.map(db.biomeName).join(', ')))}</div>`;
    // the cycle timer resets to 0, so at most one item per frame
    cycleTitle = tk('UI_DRILL_FRAME', `${fmtRate(3600 / Math.ceil(c.cycle * 60 - 1e-6))}${unitLabel()}`);
  }
  return `<div class="node${selectedCls(n)}" data-node="${n.id}" style="left:${n.x}px;top:${n.y}px">
    <div class="node-head">
      ${iconHtml('buildings', b.id, 24)}<span class="node-title" title="${esc(db.buildingName(b))}">${esc(db.buildingName(b))}</span>
      <span class="stepper">
        <button data-act="dec" tabindex="-1">−</button><input data-act="count" type="number" min="1" step="1" value="${n.count}"><button data-act="inc" tabindex="-1">+</button>
      </span>
      <button class="icon" data-act="remove" title="${esc(tk('UI_REMOVE'))}">×</button>
    </div>
    <div class="node-body">
      <select class="recipe" data-act="recipe">${options}</select>
      <div class="meta">${c.gen ? `
        ${b.fuel ? `<span title="${esc(c.parts.efficiency ? tk('UI_BONUS_EFFICIENCY', pct(c.parts.efficiency)) : '')}">${esc(tk('UI_FUEL_BURN', fmtTime(c.cycle)))}</span>` : ''}
        <span class="made" title="${esc(tk('UI_GEN_EACH', c.energyEach))}">⚡ +${fmtNum(c.energyMade)}</span>` : `
        <span${cycleTitle ? ` title="${esc(cycleTitle)}"` : ''}>${esc(tk('UI_CYCLE', fmtTime(c.cycle)))}</span>
        <span title="${esc(speedTitle(c.parts))}">${esc(tk('PRODUCTION_SPEED_LABEL', fmtNum(c.speed)))}</span>
        ${plots}${energy}`}${island}${unplacedHtml(n)}
      </div>
      ${extras}
      ${portsHtml(c.inputs, 'in')}
      ${portsHtml(c.outputs, 'out')}
      ${coverageHtml(c)}
    </div>
  </div>`;
}

function unplacedHtml(n) {
  if (!n.g || !islandHasLayout(n.g)) return '';
  const k = unplacedCount(n.id);
  return k ? `<span class="unplaced">${esc(tk('UI_ARCH_NOT_PLACED', k))}</span>` : '';
}

function goalTitle(n) {
  const preset = n.preset != null ? db.goalPresets.find(p => p.id === n.preset) : null;
  return preset ? db.goalLabel(preset) : tk('UI_GOAL');
}

function goalHtml(n) {
  const c = calc.nodes.get(n.id);
  if (!c) return '';
  const itemPairs = [['', tk('UI_CHOOSE_ITEM')], ...db.itemsByName.map(it => [it.id, db.itemName(it.id)])];
  const rows = (n.items ?? []).map((row, i) => `<div class="goal-row">
      <select data-act="goal-item" data-i="${i}">${optionList(itemPairs, row.item)}</select>
      <input data-act="goal-amount" data-i="${i}" type="number" min="0" step="any" value="${row.amount}">
      <button class="icon" data-act="goal-del" data-i="${i}" title="${esc(tk('UI_REMOVE'))}">×</button>
    </div>`).join('');
  return `<div class="node goal${selectedCls(n)}" data-node="${n.id}" style="left:${n.x}px;top:${n.y}px">
    <div class="node-head">
      <span class="node-title">🎯 ${esc(goalTitle(n))}</span>
      <button class="icon" data-act="remove" title="${esc(tk('UI_REMOVE'))}">×</button>
    </div>
    <div class="node-body">
      ${rows}
      <div class="goal-ctl">
        <button data-act="goal-add">${esc(tk('UI_GOAL_ADD_ITEM'))}</button>
        <label>${esc(tk('UI_GOAL_EVERY'))}
          <input data-act="goal-every" type="number" min="0" step="any" value="${n.every ?? 1}">
          <select data-act="goal-per">${optionList([['min', tk('UI_GOAL_PER_MIN')], ['h', tk('UI_GOAL_PER_H')]], n.per ?? 'min')}</select>
        </label>
      </div>
      ${portsHtml(c.inputs, 'in')}
      <div class="goal-ctl"><button class="primary" data-act="goal-build" title="${esc(tk('UI_GOAL_BUILD_TITLE'))}">${esc(tk('UI_GOAL_BUILD'))}</button></div>
      ${coverageHtml(c)}
    </div>
  </div>`;
}

function speedTitle(parts) {
  const bonuses = [
    ['UI_BONUS_CREATURES', parts.creatures], ['UI_BONUS_SKILLS', parts.skills],
    ['UI_BONUS_GEM', parts.gem], ['UI_BONUS_LUBRICANT', parts.lubricant],
  ].filter(([, v]) => v).map(([k, v]) => tk(k, pct(v)));
  if (parts.fertilizer) bonuses.push(tk('UI_BONUS_FERTILIZER', fmtNum(parts.fertilizer)));
  return [tk('UI_BONUS_BASE', fmtNum(parts.base)), ...bonuses].join('\n');
}

function portHtml(p) {
  const st = portStatus(p);
  const left = p.rate - p.flow;
  const unit = unitLabel();
  let delta = '';
  let title = tk('UI_PORT_EXTERNAL');
  if (st === 'ok') title = tk('UI_PORT_OK');
  if (st === 'short') { delta = `−${fmtRate(left)}`; title = tk('UI_PORT_SHORT', `${fmtRate(left)}${unit}`); }
  if (st === 'surplus') { delta = `+${fmtRate(left)}`; title = tk('UI_PORT_SURPLUS', `${fmtRate(left)}${unit}`); }
  title += ` · ${tk('UI_PER_BUILDING', `${fmtRate(p.perBuilding)}${unit}`)}`;
  const amount = p.amount != null && !p.lubricant && !p.water && !p.fertilizer ? `${db.fmtAmount(p.amount)}× ` : '';
  const bonus = p.baseAmount ? ` <span class="bonus" title="${esc(tk('UI_OUTPUT_BONUS', p.baseAmount))}">★</span>` : '';
  const act = p.dir === 'in' ? 'add-producer' : 'add-consumer';
  const actTitle = tk(p.dir === 'in' ? 'UI_ADD_PRODUCER' : 'UI_ADD_CONSUMER');
  return `<div class="prow st-${st}" title="${esc(title)}">
    <span class="port" data-node="${p.node}" data-item="${p.item}" data-dir="${p.dir}"></span>
    ${iconHtml('items', p.item)}<span class="pname">${amount}${esc(db.itemName(p.item))}${bonus}</span>
    <span class="prate">${fmtRate(p.rate)}${unit}${delta ? `<span class="delta">${delta}</span>` : ''}</span>
    <button class="padd" data-act="${act}" data-item="${p.item}" title="${esc(actTitle)}" tabindex="-1">+</button>
  </div>`;
}

function portCenter(nodeId, item, dir) {
  const p = el.nodes.querySelector(`.port[data-node="${nodeId}"][data-item="${item}"][data-dir="${dir}"]`);
  return p ? centerOf(p) : null;
}

function centerOf(elem) {
  const r = elem.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function renderEdges() {
  if (!calc) return;
  let html = '';
  for (const ce of calc.edges) {
    const a = portCenter(ce.e.from[0], ce.e.from[1], 'out');
    const b = portCenter(ce.e.to[0], ce.e.to[1], 'in');
    if (!a || !b) continue;
    const d = curve(a, b);
    const st = ce.flow <= EPS ? 'idle' : portStatus(ce.dst) === 'short' ? 'short' : 'ok';
    const sel = selection?.kind === 'edge' && selection.id === ce.e.id ? ' selected' : '';
    const cross = findNode(ce.e.from[0])?.g !== findNode(ce.e.to[0])?.g ? ' cross' : '';
    const hl = hoverItem != null && ce.e.from[1] === hoverItem ? ' hl' : '';
    const noRoute = ce.transport && ce.transport.cap <= EPS ? ' noroute' : '';
    html += `<g class="edge st-${st}${sel}${cross}${hl}${noRoute}" data-edge="${ce.e.id}" data-item="${ce.e.from[1]}">
      ${ce.transport ? `<title>${esc(transportTitle(ce))}</title>` : ''}<path class="hit" d="${d}"/><path class="line" d="${d}"/>
      <text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2}">${fmtRate(ce.flow)}</text></g>`;
  }
  el.edgeLayer.innerHTML = html;
}

/**
 * Island boxes on the board: around their cards (optionally leaving one card out), or the remembered spot of an
 * island without cards. The frame is drawn 30px around the box (56px above for the title).
 */
function islandBoxes(exceptId) {
  const boxes = new Map();
  for (const n of state.nodes) {
    if (!n.g || !state.groups[n.g] || n.id === exceptId) continue;
    const e = el.nodes.querySelector(`.node[data-node="${n.id}"]`);
    const h = e?.offsetHeight || heightOf(calc?.nodes.get(n.id));
    const b = boxes.get(n.g) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    b.x0 = Math.min(b.x0, n.x); b.y0 = Math.min(b.y0, n.y);
    b.x1 = Math.max(b.x1, n.x + NODE_W); b.y1 = Math.max(b.y1, n.y + h);
    boxes.set(n.g, b);
  }
  for (const [g, grp] of Object.entries(state.groups)) {
    if (!boxes.has(g) && grp.frame) boxes.set(g, { x0: grp.frame.x, y0: grp.frame.y, x1: grp.frame.x + NODE_W, y1: grp.frame.y + 120 });
  }
  return boxes;
}

const inFrame = (b, x, y, margin = 0) => b && x > b.x0 - 30 - margin && x < b.x1 + 30 + margin && y > b.y0 - 56 - margin && y < b.y1 + 30 + margin;

const boxArea = b => (b.x1 - b.x0) * (b.y1 - b.y0);

/** Island whose frame contains a board point (the smallest one when frames overlap). */
function islandAtBoard(x, y, boxes = islandBoxes(), skip) {
  let best;
  for (const [g, b] of boxes) if (g !== skip && inFrame(b, x, y) && (!best || boxArea(b) < boxArea(best[1]))) best = [g, b];
  return best?.[0];
}

/** Tooltip of a link between islands: what the transporters on that route can carry. */
function transportTitle(ce) {
  const item = db.itemName(ce.e.from[1]);
  const a = state.groups[findNode(ce.e.from[0])?.g]?.title ?? '';
  const b = state.groups[findNode(ce.e.to[0])?.g]?.title ?? '';
  if (ce.transport.cap <= EPS) return tk('UI_EDGE_NO_TRANSPORT', item, a, b);
  if (ce.transport.cap >= DRONE_CAP) return tk('UI_EDGE_DRONE', item, a, b);
  return tk('UI_EDGE_TRANSPORT', item, a, b, `${fmtRate(ce.transport.cap)}${unitLabel()}`);
}

/** Island frames around their nodes (derived from node positions, so they follow drags). */
function renderFrames() {
  if (state.boardView === 'chain') { el.frames.innerHTML = ''; return; }
  const boxes = islandBoxes();
  for (const [g, b] of boxes) state.groups[g].frame = { x: b.x0, y: b.y0 }; // an island keeps its spot when its cards leave
  el.frames.innerHTML = [...boxes].map(([g, b]) => {
    const e = calc?.energyByGroup.get(g);
    const energy = e && (e.used || e.made)
      ? ` <span class="frame-energy${e.used > e.made ? ' neg' : ''}" title="${esc(tk('UI_ENERGY_TITLE'))}">⚡ ${e.used} / ${e.made}</span>` : '';
    return `<div class="frame" style="left:${b.x0 - 30}px;top:${b.y0 - 56}px;width:${b.x1 - b.x0 + 60}px;height:${b.y1 - b.y0 + 86}px">
      <div class="frame-title" data-group="${esc(g)}" title="${esc(tk('UI_ISLAND_RENAME_TITLE'))}">${esc(state.groups[g].title)}${energy}<button class="icon" data-act="del-island" title="${esc(tk('UI_ISLAND_DELETE'))}">×</button></div></div>`;
  }).join('');
}

function renderOverlay() {
  renderFrames();
  renderEdges();
}

function scheduleOverlay() {
  if (overlayFrame) return;
  overlayFrame = requestAnimationFrame(() => { overlayFrame = 0; renderOverlay(); });
}

function renderSummary() {
  if (!state.nodes.length) {
    el.summary.innerHTML = `<p class="muted">${esc(tk('UI_SUMMARY_EMPTY'))}</p>`;
    return;
  }
  const rows = [...calc.items.values()].sort((a, b) => a.net - b.net || db.itemName(a.item).localeCompare(db.itemName(b.item)));
  const cls = v => (v < -EPS ? 'neg' : v > EPS ? 'pos' : '');
  const signed = v => (Math.abs(v) <= EPS ? '0' : `${v > 0 ? '+' : '−'}${fmtRate(Math.abs(v))}`);
  el.summary.innerHTML = `
    <div class="stats">
      <div><span>${esc(tk('UI_BUILDINGS'))}</span><b>${calc.buildingCount}</b></div>
      <div title="${esc(tk('UI_ENERGY_TITLE'))}"><span>${esc(tk('UI_ENERGY'))}</span><b class="${calc.energy > calc.energyMade ? 'neg' : ''}">⚡ ${fmtNum(calc.energy)} / ${fmtNum(calc.energyMade)}</b></div>
    </div>
    <table>
      <tr><th>${esc(tk('UI_ITEM'))}</th><th>${esc(tk('UI_PRODUCED'))}</th><th>${esc(tk('UI_CONSUMED'))}</th><th>${esc(tk('UI_NET'))}</th></tr>
      ${rows.map(r => `<tr data-item="${r.item}"${r.item === hoverItem ? ' class="hl"' : ''}>
        <td title="${esc(`${db.itemName(r.item)}
${tk('UI_SUMMARY_FOCUS')}`)}">${iconHtml('items', r.item, 16)}${esc(db.itemName(r.item))}</td>
        <td>${r.produced > EPS ? fmtRate(r.produced) : ''}</td>
        <td>${r.consumed > EPS ? fmtRate(r.consumed) : ''}</td>
        <td class="${cls(r.net)}">${signed(r.net)}</td></tr>`).join('')}
    </table>`;
}

// ---------- catalog ----------

const catalogOpen = new Map(); // details key -> open, kept across re-renders
const openAttr = (key, byDefault = false) => ((el.search.value.trim() || (catalogOpen.get(key) ?? byDefault)) ? ' open' : '');

function renderCatalog() {
  for (const d of el.catalog.querySelectorAll('details[data-key]')) catalogOpen.set(d.dataset.key, d.open);
  const top = el.catalog.scrollTop;
  if (state.mode === 'arch') renderArchCatalog(); else renderBoardCatalog();
  el.catalog.scrollTop = top;
}

function renderBoardCatalog() {
  const q = el.search.value.trim().toLowerCase();
  const hasItem = list => list.some(s => db.itemName(s.item).toLowerCase().includes(q));
  const matches = e => !q
    || db.buildingName(e.b).toLowerCase().includes(q)
    || (e.creature && db.creatureName(e.creature).toLowerCase().includes(q))
    || (e.r.crop && db.plantName(e.r.crop).toLowerCase().includes(q))
    || hasItem([...e.r.inputs, ...e.r.outputs]);

  const goals = db.goalPresets.filter(p => !q || db.goalLabel(p).toLowerCase().includes(q) || hasItem(p.items));
  const custom = !q || tk('UI_GOAL_CUSTOM').toLowerCase().includes(q);
  let html = '';
  if (goals.length || custom) {
    html += `<details data-key="goals"${openAttr('goals')}><summary><span>${esc(tk('UI_GOALS'))}</span><span class="count">${goals.length + (custom ? 1 : 0)}</span></summary>
      ${custom ? `<button class="entry" data-goal=""><span class="out">🎯 ${esc(tk('UI_GOAL_CUSTOM'))}</span><span class="in">${esc(tk('UI_GOAL_CUSTOM_HINT'))}</span></button>` : ''}
      ${goals.map(p => `<button class="entry" data-goal="${p.id}"><span class="out">🎯 ${esc(db.goalLabel(p))}</span><span class="in">${esc(db.stackText(p.items))}</span></button>`).join('')}
    </details>`;
  }
  for (const b of db.productionBuildings) {
    const list = (db.entriesByBuilding.get(b.id) ?? []).filter(matches);
    if (!list.length) continue;
    html += `<details data-key="b${b.id}"${openAttr(`b${b.id}`)}><summary><span>${iconHtml('buildings', b.id, 22)}${esc(db.buildingName(b))}</span><span class="count">${list.length}</span></summary>
      ${list.map(e => entryButton(e, false)).join('')}</details>`;
  }
  el.catalog.innerHTML = html || `<p class="empty">${esc(tk('UI_NOTHING_FOUND'))}</p>`;
}

/** Architect catalog: cards with buildings still to place, production entries, infrastructure. */
/** With a save loaded, only building types it has a record of can be placed (a new one is a copy of such a record). */
const placeable = bId => !state.saveInfo || state.saveInfo.types.includes(bId);
const noTemplate = bId => (placeable(bId) ? '' : ` disabled title="${esc(tk('UI_SAVE_NO_TEMPLATE'))}"`);

function renderArchCatalog() {
  const q = el.search.value.trim().toLowerCase();
  const has = text => !q || text.toLowerCase().includes(q);
  let html = '';
  const open = state.nodes.filter(n => !isGoal(n) && unplacedCount(n.id) > 0).map(n => {
    const b = db.buildings.get(n.b);
    const e = db.findEntry(n.b, n.r, n.c);
    const where = n.g ? state.groups[n.g]?.title : tk('UI_ARCH_NO_ISLAND');
    return { n, b, text: `${db.buildingName(b)} ${e ? db.entryLabel(e) : ''} ${where}`, e, where };
  }).filter(x => has(x.text));
  if (open.length) {
    html += `<details data-key="unplaced"${openAttr('unplaced', true)}><summary><span>${esc(tk('UI_ARCH_UNPLACED'))}</span><span class="count">${open.reduce((k, x) => k + unplacedCount(x.n.id), 0)}</span></summary>
      ${open.map(x => `<button class="entry" data-node="${esc(x.n.id)}"${noTemplate(x.b.id)}>
        <span class="bld">${esc(x.where ?? '')}</span>
        <span class="out">${iconHtml('buildings', x.b.id)}${esc(db.buildingName(x.b))} ×${unplacedCount(x.n.id)}</span>
        <span class="in">${esc(x.e ? db.entryLabel(x.e) : '')}</span></button>`).join('')}</details>`;
  }
  for (const b of db.productionBuildings) {
    const list = (db.entriesByBuilding.get(b.id) ?? []).filter(e => has(`${db.buildingName(e.b)} ${db.entryLabel(e)} ${db.stackText(e.r.inputs)}`));
    if (!list.length) continue;
    html += `<details data-key="b${b.id}"${openAttr(`b${b.id}`)}><summary><span>${iconHtml('buildings', b.id, 22)}${esc(db.buildingName(b))}</span><span class="count">${list.length}</span></summary>
      ${list.map(e => entryButton(e, false, noTemplate(b.id))).join('')}</details>`;
  }
  const infra = db.infraBuildings.filter(b => has(db.buildingName(b)));
  if (infra.length) {
    html += `<details data-key="infra"${openAttr('infra')}><summary><span>${esc(tk('UI_ARCH_INFRA'))}</span><span class="count">${infra.length}</span></summary>
      ${infra.map(b => `<button class="entry" data-infra="${b.id}"${noTemplate(b.id)}><span class="out">${iconHtml('buildings', b.id)}${esc(db.buildingName(b))}</span></button>`).join('')}</details>`;
  }
  el.catalog.innerHTML = html || `<p class="empty">${esc(tk('UI_NOTHING_FOUND'))}</p>`;
  markArmed(archView?.armed());
}

/** Highlight the catalog button whose building is armed for placing. */
function markArmed(a) {
  for (const btn of el.catalog.querySelectorAll('.entry')) {
    const on = !!a && (a.node ? btn.dataset.node === a.node
      : a.entry ? btn.dataset.b === String(a.entry.b.id) && btn.dataset.r === String(a.entry.r.id) && (btn.dataset.c || null) === (a.entry.creature?.key ?? null)
        : btn.dataset.infra === String(a.b.id));
    btn.classList.toggle('armed', on);
  }
}

function entryButton(e, withBuilding, attrs = '') {
  const ins = e.r.inputs.length ? db.stackText(e.r.inputs) : '';
  return `<button class="entry" data-b="${e.b.id}" data-r="${esc(e.r.id)}" data-c="${e.creature?.key ?? ''}"${attrs}>
    ${withBuilding ? `<span class="bld">${esc(db.buildingName(e.b))}</span>` : ''}
    <span class="out">${e.r.outputs[0] ? iconHtml('items', e.r.outputs[0].item) : '⚡'}${esc(db.entryLabel(e))}</span>
    <span class="in">${ins ? `${esc(ins)} · ` : ''}${esc(e.r.gen ? '' : fmtTime(e.r.time / nodeSpeed({ creatures: 1 }, e.b, db, state.mods)))}</span>
  </button>`;
}

const entryFromButton = btn => db.findEntry(+btn.dataset.b, parseRecipeId(btn.dataset.r), btn.dataset.c || null);

// ---------- board edits ----------

function addNode(entry, x, y, count = 1) {
  const node = {
    id: newId('n'), b: entry.b.id, r: entry.r.id, count, x: Math.round(x), y: Math.round(y),
    ...(entry.creature ? { c: entry.creature.key } : {}),
    ...(entry.b.maxCreatures ? { creatures: 1 } : {}),
  };
  state.nodes.push(node);
  return node;
}

function addGoal(preset, x, y) {
  const node = {
    id: newId('n'), kind: 'goal', x: Math.round(x), y: Math.round(y),
    items: preset ? preset.items.map(s => ({ ...s })) : [{ item: null, amount: 1 }],
    // delivery points want a one-off batch: default to "within 10 hours"
    every: preset ? 10 : 1, per: preset ? 'h' : 'min', ...(preset ? { preset: preset.id } : {}),
  };
  state.nodes.push(node);
  return node;
}

function addEdge(fromNode, toNode, item) {
  if (fromNode === toNode) return;
  if (state.edges.some(e => e.from[0] === fromNode && e.to[0] === toNode && e.from[1] === item)) return;
  state.edges.push({ id: newId('e'), from: [fromNode, item], to: [toNode, item] });
}

function dropNode(id) {
  state.nodes = state.nodes.filter(n => n.id !== id);
  state.edges = state.edges.filter(e => e.from[0] !== id && e.to[0] !== id);
  if (selection?.id === id) selection = null;
}

function removeNode(id) {
  dropNode(id);
  commit();
}

function removeEdge(id) {
  state.edges = state.edges.filter(e => e.id !== id);
  if (selection?.id === id) selection = null;
  commit();
}

/** First y at or below `y` where a node of height `h` placed at `x` does not overlap existing nodes. */
function freeY(x, y, h) {
  const rects = state.nodes.map(n => ({
    x: n.x, y: n.y, h: el.nodes.querySelector(`.node[data-node="${n.id}"]`)?.offsetHeight || heightOf(calc?.nodes.get(n.id)),
  }));
  const hit = yy => rects.find(r => x < r.x + NODE_W + 20 && x + NODE_W + 20 > r.x && yy < r.y + r.h + 16 && yy + h + 16 > r.y);
  for (let r = hit(y); r; r = hit(y)) y = r.y + r.h + 24;
  return y;
}

const estimateHeight = entry => 110 + 26 * (entry.r.inputs.length + entry.r.outputs.length)
  + (entry.b.maxCreatures || entry.b.lubricant ? 24 : 0) + (entry.b.farm ? 50 : 0) + (entry.b.class === 'DrillerBuilding' ? 50 : 0);

/** Card height estimate from computed ports (for layouts made before the cards exist). */
function heightOf(c) {
  if (!c) return 200;
  if (c.goal) return 150 + 34 * (c.n.items?.length ?? 1) + 26 * c.inputs.size;
  const b = c.b;
  return 110 + 26 * (c.inputs.size + c.outputs.size)
    + (b.lubricant || b.maxCreatures || b.class === 'DrillerBuilding' ? 24 : 0) + (b.farm ? 24 : 0)
    + (c.r.crop && c.r.crop.harvest.type !== 'once' ? 24 : 0);
}

function viewCenterWorld() {
  const r = el.viewport.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 3);
}

/** Items per minute one building of `entry` makes of `item` under the current bonuses (no lubricant/fertilizer). */
function perBuildingRate(entry, item) {
  const s = entry.r.outputs.find(o => o.item === item);
  if (!s) return 0;
  const amount = outputAmount(s.amount, outputBonus(entry.b, db, state.mods));
  return amount * 60 / (entry.r.time / nodeSpeed({ creatures: 1 }, entry.b, db, state.mods)) * (entry.b.farm?.plots ?? 1);
}

/**
 * Add a building that supplies (role 'producer') or takes (role 'consumer') `item` for an existing port,
 * sized to cover the port's open amount, and connect it.
 */
function addLinked(entry, ctx) {
  const origin = calc.nodes.get(ctx.node);
  const port = ctx.role === 'producer' ? origin?.inputs.get(ctx.item) : origin?.outputs.get(ctx.item);
  if (!port) return;
  let per;
  if (ctx.role === 'producer') {
    per = perBuildingRate(entry, ctx.item);
  } else {
    const amount = entry.r.inputs.find(s => s.item === ctx.item)?.amount ?? 1;
    per = amount * 60 / (entry.r.time / nodeSpeed({ creatures: 1 }, entry.b, db, state.mods)) * (entry.b.farm?.plots ?? 1);
  }
  let need = port.rate - port.flow;
  if (need <= EPS) need = port.rate;
  const count = ctx.role === 'producer'
    ? Math.max(1, Math.ceil(need / per - 1e-9))
    : Math.max(1, Math.floor(need / per + 1e-9));

  const o = origin.n;
  let x;
  let y;
  if (ctx.place) {
    x = ctx.role === 'producer' ? ctx.place.x - NODE_W : ctx.place.x;
    y = ctx.place.y - 20;
  } else {
    x = ctx.role === 'producer' ? o.x - NODE_W - GAP_X : o.x + NODE_W + GAP_X;
    y = freeY(x, o.y, estimateHeight(entry));
  }
  const node = addNode(entry, x, y, count);
  if (o.g) node.g = o.g;
  if (ctx.role === 'producer') addEdge(node.id, o.id, ctx.item);
  else addEdge(o.id, node.id, ctx.item);
  selection = { kind: 'node', id: node.id };
  commit();
  return node;
}

// ---------- islands and buildings placed on them (architect) ----------

const placedCount = id => state.placed.reduce((k, p) => k + (p.node === id ? 1 : 0), 0);
function unplacedCount(id) {
  const n = findNode(id);
  return n && !isGoal(n) ? Math.max(0, n.count - placedCount(id)) : 0;
}
const islandHasLayout = g => state.placed.some(p => p.g === g);

/** Keep placed buildings consistent with the cards: same island, at most `count` per card, islands that exist. */
function syncPlaced() {
  const nodes = new Map(state.nodes.map(n => [n.id, n]));
  const seen = new Map();
  const alive = new Set(state.placed.filter(p => state.groups[p.g]).map(p => p.id));
  state.placed = state.placed.filter(p => {
    if (!state.groups[p.g]) return false;
    if (p.twin && !alive.has(p.twin)) return false; // a transporter needs both arms
    if (p.node == null) return true;
    const n = nodes.get(p.node);
    if (!n || isGoal(n) || n.g !== p.g || n.b !== p.b) return false;
    const k = (seen.get(n.id) ?? 0) + 1;
    seen.set(n.id, k);
    return k <= n.count;
  });
  const byId = new Map(state.placed.map(p => [p.id, p]));
  for (const p of state.placed) if (p.targets) p.targets = p.targets.filter(id => byId.has(id) && id !== p.id);
  // a magnetoid needs both buildings, on one island, with a Magnetoid Antenna
  const antennas = new Set(state.placed.filter(p => p.b === db.magnetAntennaId).map(p => p.g));
  state.magnets = (state.magnets ?? []).filter(m => {
    const a = byId.get(m.from); const b = byId.get(m.to);
    return a && b && a.g === b.g && antennas.has(a.g);
  });
}

const SETUP_KEYS = ['b', 'r', 'c', 'creatures', 'lub', 'fert', 'water'];
const sameSetup = (a, b) => SETUP_KEYS.every(k => (a[k] ?? null) === (b[k] ?? null));

/** Board spot for a new card of island g: under its cards, in its empty frame, or below everything. */
function spotForCard(g, h) {
  const mine = state.nodes.filter(n => n.g === g);
  if (mine.length) {
    const x = Math.min(...mine.map(n => n.x));
    return { x, y: freeY(x, Math.min(...mine.map(n => n.y)), h) };
  }
  const fr = state.groups[g]?.frame;
  if (fr) return { x: fr.x, y: freeY(fr.x, fr.y, h) };
  const bottom = state.nodes.length ? Math.max(...state.nodes.map(n => n.y + heightOf(calc?.nodes.get(n.id)))) + 200 : 0;
  return { x: 0, y: bottom };
}

/** The card on island g with the setup of `like` (a new one with count 0 when there is none). */
function cardOn(g, like) {
  let n = state.nodes.find(x => !isGoal(x) && x.g === g && sameSetup(x, like));
  if (!n) {
    const entry = db.findEntry(like.b, like.r, like.c);
    const pos = spotForCard(g, entry ? estimateHeight(entry) : 200);
    n = { id: newId('n'), count: 0, x: Math.round(pos.x), y: Math.round(pos.y), g };
    for (const k of SETUP_KEYS) if (like[k] != null) n[k] = like[k];
    state.nodes.push(n);
    linkNode(n);
  }
  return n;
}

/**
 * Connect a new card: its inputs to the producers on its island (else those transporters bring here, else any),
 * its outputs to the consumers on its island.
 */
function linkNode(n) {
  const c = compute(state, db);
  const me = c.nodes.get(n.id);
  if (!me) return;
  const others = state.nodes.filter(m => m !== n);
  for (const item of me.inputs.keys()) {
    const prods = others.filter(m => c.nodes.get(m.id)?.outputs.has(item));
    const local = prods.filter(m => m.g === n.g);
    const routed = prods.filter(m => !c.net.enforced(m.g, n.g) || c.net.cap(item, m.g, n.g) > EPS);
    for (const m of local.length ? local : routed.length ? routed : prods) addEdge(m.id, n.id, item);
  }
  for (const item of me.outputs.keys()) {
    for (const m of others) if (m.g === n.g && c.nodes.get(m.id)?.inputs.has(item)) addEdge(n.id, m.id, item);
  }
}

/** Architect: start placing the not yet placed buildings of a card. */
function armCard(id) {
  const n = findNode(id);
  if (n && !placeable(n.b)) { toast(tk('UI_SAVE_NO_TEMPLATE'), true); return; }
  if (n && unplacedCount(id) > 0) archView.arm({ b: db.buildings.get(n.b), node: id });
}

/** Take one building off card n and add it to the matching card on island g; returns that card. */
function transferOne(n, g) {
  const t = cardOn(g, n);
  t.count += 1;
  n.count -= 1;
  if (n.count <= 0) dropNode(n.id);
  return t;
}

const armId = key => db.infraBuildings.find(b => b.key === key)?.id ?? [...db.buildings.values()].find(b => b.key === key)?.id;

/** The island facing shore slot `slot` of island g and the paired slot there, or null when there is no island. */
function armTwinSpot(g, slot) {
  const grp = state.groups[g];
  if (!grp || grp.q == null) return null;
  const c = hexCenter(grp.q, grp.r);
  const pair = slotPair(slot);
  const { q, r } = hexAt(c.x + pair.dx, c.y + pair.dy);
  const g2 = Object.keys(state.groups).find(k => state.groups[k].q === q && state.groups[k].r === r);
  return g2 ? { g: g2, slot: pair.slot } : null;
}

const placeOps = {
  /** Place what the architect armed ({ b, entry? | node? }) on island g at (x, y). */
  place(armed, g, x, y) {
    const at = { id: newId('p'), b: armed.b.id, g, x, y };
    if (armed.node) {
      const n = findNode(armed.node);
      if (!n) return;
      if (n.g == null) n.g = g;
      const card = n.g === g ? n : transferOne(n, g);
      state.placed.push({ ...at, node: card.id });
    } else if (armed.entry) {
      const e = armed.entry;
      const like = { b: e.b.id, r: e.r.id, c: e.creature?.key, creatures: e.b.maxCreatures ? 1 : undefined };
      // a matching card on this island with a building still to place takes it; otherwise the card grows by one
      let n = state.nodes.find(x => !isGoal(x) && x.g === g && x.b === like.b && x.r === like.r
        && (x.c ?? null) === (like.c ?? null) && unplacedCount(x.id) > 0);
      if (!n) { n = cardOn(g, like); n.count += 1; }
      state.placed.push({ ...at, node: n.id });
    } else {
      state.placed.push(at);
    }
    commit();
    renderCatalog();
  },
  move(id, g, x, y) {
    const p = state.placed.find(q => q.id === id);
    if (!p) return;
    state.magnets = state.magnets.filter(m => m.from !== id && m.to !== id); // its magnetoids no longer reach
    if (p.g !== g && p.node != null) {
      const n = findNode(p.node);
      if (n) p.node = transferOne(n, g).id;
    }
    Object.assign(p, { g, x, y });
    commit();
  },
  /** A transporter: input arm on slot `slot` of island g, output arm on the paired slot of the facing island. */
  placeTransporter(g, slot) {
    const twin = armTwinSpot(g, slot);
    if (!twin) return;
    const a = { id: newId('p'), b: armId('TransporterContainerInput'), g, slot, x: TRANSPORTER_SLOTS[slot][0], y: TRANSPORTER_SLOTS[slot][1] };
    const b = { id: newId('p'), b: armId('TransporterContainerOutput'), g: twin.g, slot: twin.slot,
      x: TRANSPORTER_SLOTS[twin.slot][0], y: TRANSPORTER_SLOTS[twin.slot][1] };
    a.twin = b.id;
    b.twin = a.id;
    state.placed.push(a, b);
    commit();
    return a.id;
  },
  /** What a transporter carries: kept on the input arm (as in saves), shown on both; drone bases and item antennas keep their own. */
  setArmItem(id, item) {
    const p = state.placed.find(q => q.id === id);
    if (p && !p.twin) {
      if (item == null) delete p.item; else p.item = item;
      commit();
      return;
    }
    const t = p && state.placed.find(q => q.id === p.twin);
    const input = [p, t].find(q => q && db.buildings.get(q.b)?.key === 'TransporterContainerInput') ?? p;
    if (!input) return;
    if (item == null) delete input.item; else input.item = item;
    commit();
  },
  /** Slide an arm along its island's shore; its twin moves to the paired slot of the island it now faces. */
  moveTransporter(id, slot) {
    const p = state.placed.find(q => q.id === id);
    const twin = p && armTwinSpot(p.g, slot);
    if (!twin) return;
    Object.assign(p, { slot, x: TRANSPORTER_SLOTS[slot][0], y: TRANSPORTER_SLOTS[slot][1] });
    const t = state.placed.find(q => q.id === p.twin);
    if (t) Object.assign(t, { g: twin.g, slot: twin.slot, x: TRANSPORTER_SLOTS[twin.slot][0], y: TRANSPORTER_SLOTS[twin.slot][1] });
    commit();
  },
  remove(id) {
    const p = state.placed.find(q => q.id === id);
    if (!p) return;
    state.placed = state.placed.filter(q => q !== p && q.id !== p.twin);
    const n = p.node != null ? findNode(p.node) : null;
    if (n) {
      n.count -= 1;
      if (n.count <= 0) dropNode(n.id);
    }
    commit();
    renderCatalog();
  },
  /** A rock / bush / tree moved on its island. */
  moveProp(id, x, y) {
    const p = state.props.find(q => q.id === id);
    if (!p) return;
    Object.assign(p, { x, y });
    commit();
  },
  /** Drone base `id` also delivers to container `target` (any island); remove = take it off the list. */
  setDroneTarget(id, target, on) {
    const p = state.placed.find(q => q.id === id);
    if (!p || p.b !== db.droneBaseId) return;
    const list = (p.targets ?? []).filter(t => t !== target);
    p.targets = on ? [...list, target] : list;
    commit();
  },
  /** A magnetoid from building `from` to `to`: needs touching free slots and a Magnetoid Antenna on the island. */
  addMagnet(from, to) {
    const a = state.placed.find(q => q.id === from);
    const c = state.placed.find(q => q.id === to);
    if (!a || !c || a === c || a.g !== c.g) return tk('UI_MAGNET_NO_PAIR');
    if (!state.placed.some(q => q.g === a.g && q.b === db.magnetAntennaId)) return tk('UI_MAGNET_NO_ANTENNA');
    if (state.magnets.some(m => (m.from === from && m.to === to) || (m.from === to && m.to === from))) return tk('UI_MAGNET_EXISTS');
    const used = id => new Set(state.magnets.flatMap(m => [m.from === id ? m.fs : null, m.to === id ? m.ts : null]).filter(v => v != null));
    const pair = magnetPair(db.buildings.get(a.b), a.x, a.y, used(from), db.buildings.get(c.b), c.x, c.y, used(to));
    if (!pair) return tk('UI_MAGNET_NO_PAIR');
    state.magnets.push({ id: newId('m'), from, to, fs: pair.from, ts: pair.to });
    commit();
    return null;
  },
  removeMagnet(id) {
    state.magnets = state.magnets.filter(m => m.id !== id);
    commit();
  },
  unplacedCount,
  newIsland: (screen, slot) => openBiomeMenu(screen, biome => createIsland(biome, slot)),
  deleteIsland,
  renameIsland,
  focusCard(id) {
    setMode('calc');
    const card = el.nodes.querySelector(`.node[data-node="${id}"]`);
    if (card) { fitView([card]); setSelection({ kind: 'node', id }); }
  },
};

/** New island of `biome` on hex slot `slot` (default: the first free one) and, on the board, at `frame`. */
function createIsland(biome, slot, frame) {
  const used = new Set(Object.values(state.groups).filter(g => g.q != null).map(g => `${g.q},${g.r}`));
  const s = slot ?? hexSlots(8).find(h => !used.has(`${h.q},${h.r}`));
  const base = db.biomeName(biome);
  const same = Object.values(state.groups).filter(g => g.title === base || g.title.startsWith(`${base} #`)).length;
  const g = newId('i');
  state.groups[g] = { title: same ? `${base} #${same + 1}` : base, biome, q: s.q, r: s.r, ...(frame ? { frame } : {}) };
  commit();
  return g;
}

function deleteIsland(g) {
  const grp = state.groups[g];
  if (!grp || !confirm(tk('UI_ISLAND_DELETE_CONFIRM', grp.title))) return;
  delete state.groups[g];
  for (const n of state.nodes) if (n.g === g) delete n.g;
  commit();
  renderCatalog();
}

function renameIsland(g) {
  const grp = state.groups[g];
  if (!grp) return;
  const t = prompt(tk('UI_ISLAND_RENAME'), grp.title);
  if (t && t.trim()) { grp.title = t.trim(); commit(); }
}

function openBiomeMenu(screen, onPick) {
  el.menu.innerHTML = `<div class="menu-title">${esc(tk('UI_ISLAND_CHOOSE_BIOME'))}</div>
    <div class="menu-list">${db.biomes.map(b => {
    const col = db.biomeColors[b];
    return `<button class="entry biome" data-biome="${esc(b)}"><span class="out"><i class="swatch" style="background:${col.ground};border-color:${col.border ?? col.ground}"></i>${esc(db.biomeName(b))}</span></button>`;
  }).join('')}</div>`;
  showMenuAt(screen);
  el.menu._ctx = { kind: 'biome', onPick };
}

function setMode(mode) {
  if (state.mode === mode) return;
  archView.disarm();
  archView.select(null);
  closeMenu();
  state.mode = mode;
  setSelection(null);
  renderCatalog();
  render();
  if (mode === 'arch' && archNeedsFit) { archNeedsFit = false; archView.fit(); }
  save();
}

/** Fit a view to a box of layer pixels {x0, y0, x1, y1}. */
function fitBox(box, maxZ = 1.2) {
  const pad = 40;
  const vw = el.viewport.clientWidth;
  const vh = el.viewport.clientHeight;
  const w = Math.max(1, box.x1 - box.x0);
  const h = Math.max(1, box.y1 - box.y0);
  const z = clamp(Math.min((vw - 2 * pad) / w, (vh - 2 * pad) / h), ZOOM_MIN, maxZ);
  return { x: (vw - w * z) / 2 - box.x0 * z, y: (vh - h * z) / 2 - box.y0 * z, z };
}

// ---------- goals: build the chain behind a goal ----------

// Not used when filling a chain automatically: drills, manual crafting, creature cloning, creatures and farms
// (their products are treated as raw resources); the Packager only for packages.
const AUTO_SKIP = new Set(['Driller', 'MegaPrinter', 'AnimalCloningMachine']);

function autoProducer(item, upstreamNodes) {
  const isPackage = db.items.get(item)?.packageOf != null;
  const cands = db.producersOf(item).filter(e => !AUTO_SKIP.has(e.b.key) && !e.creature && !e.b.farm
    && (e.b.key !== 'Packager' || isPackage));
  if (!cands.length) return null;
  const used = new Set(upstreamNodes.map(n => `${n.b}|${n.r}`));
  const reused = cands.find(e => used.has(`${e.b.id}|${e.r.id}`));
  if (reused) return reused;
  // Mega recipes eat packages (1 package = 100 items): fast per building, ruinous in materials. Use them only
  // when nothing else makes the item; otherwise take the fastest plain recipe.
  const takesPackages = e => e.r.inputs.some(s => db.items.get(s.item)?.packageOf != null);
  const plain = cands.filter(e => !takesPackages(e));
  const pool = plain.length ? plain : cands;
  return pool.reduce((best, e) => (perBuildingRate(e, item) > perBuildingRate(best, item) ? e : best));
}

function upstreamOf(id) {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of state.edges) if (e.to[0] === cur && !seen.has(e.from[0])) { seen.add(e.from[0]); queue.push(e.from[0]); }
  }
  return seen;
}

function buildChain(goalId) {
  const goal = findNode(goalId);
  const raw = new Set();
  const added = [];
  // one deficit per step; raising a count ripples down to its suppliers, so allow plenty of steps
  for (let step = 0; step < 3000; step++) {
    calc = compute(state, db);
    const upstream = upstreamOf(goalId);
    let target = null;
    for (const id of upstream) {
      for (const p of calc.nodes.get(id)?.inputs.values() ?? []) {
        if (p.rate - p.flow > EPS * Math.max(1, p.rate) && !raw.has(p.item)) { target = p; break; }
      }
      if (target) break;
    }
    if (!target) break;
    const upNodes = [...upstream].map(findNode).filter(n => n && !isGoal(n));
    const entry = autoProducer(target.item, upNodes);
    if (!entry) { raw.add(target.item); continue; }
    const per = perBuildingRate(entry, target.item);
    const deficit = target.rate - target.flow;
    const existing = upNodes.find(n => n.b === entry.b.id && n.r === entry.r.id && n.lub == null);
    if (existing) {
      const out = calc.nodes.get(existing.id).outputs.get(target.item);
      addEdge(existing.id, target.node, target.item);
      const spare = Math.max(0, out.rate - out.flow);
      if (deficit > spare + EPS) existing.count += Math.ceil((deficit - spare) / per - 1e-9);
    } else {
      const node = addNode(entry, 0, 0, Math.max(1, Math.ceil(deficit / per - 1e-9)));
      if (goal.g) node.g = goal.g;
      addEdge(node.id, target.node, target.item);
      added.push(node);
    }
  }
  if (added.length) {
    // lay out the goal and its new suppliers, keeping the goal where it was
    const gx = goal.x;
    const gy = goal.y;
    const sub = [goal, ...added];
    const ids = new Set(sub.map(n => n.id));
    const c = compute(state, db);
    layoutBoard(sub, state.edges.filter(e => ids.has(e.from[0]) && ids.has(e.to[0])), n => heightOf(c.nodes.get(n.id)));
    const dx = gx - goal.x;
    const dy = gy - goal.y;
    for (const n of sub) { n.x += dx; n.y += dy; }
  }
  commit();
  toast(tk('UI_GOAL_BUILT', added.length, [...raw].map(db.itemName).join(', ') || '—'));
}

// ---------- popup menu ----------

function openMenu(screen, ctx) {
  const entries = ctx.role === 'producer' ? db.producersOf(ctx.item) : db.consumersOf(ctx.item);
  const title = `${tk(ctx.role === 'producer' ? 'UI_ADD_PRODUCER' : 'UI_ADD_CONSUMER')}: ${db.itemName(ctx.item)}`;
  const none = tk(ctx.role === 'producer' ? 'UI_NO_RECIPES' : 'UI_NO_CONSUMERS');
  el.menu.innerHTML = `<div class="menu-title">${esc(title)}</div>
    ${entries.length > 8 ? `<input type="search" placeholder="${esc(tk('UI_SEARCH'))}">` : ''}
    <div class="menu-list">${entries.length ? entries.map(e => entryButton(e, true)).join('') : `<p class="empty">${esc(none)}</p>`}</div>`;
  showMenuAt(screen);
  el.menu._ctx = ctx;
  const input = el.menu.querySelector('input');
  if (input) {
    input.focus();
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      for (const btn of el.menu.querySelectorAll('.entry')) btn.hidden = q && !btn.textContent.toLowerCase().includes(q);
    });
  }
}

function showMenuAt(screen) {
  el.menu.hidden = false;
  const w = el.menu.offsetWidth;
  const h = el.menu.offsetHeight;
  el.menu.style.left = `${clamp(screen.x, 8, window.innerWidth - w - 8)}px`;
  el.menu.style.top = `${clamp(screen.y, 8, window.innerHeight - h - 8)}px`;
}

function closeMenu() {
  el.menu.hidden = true;
  el.menu._ctx = null;
}

el.menu.addEventListener('click', ev => {
  const btn = ev.target.closest('.entry');
  if (!btn || !el.menu._ctx) return;
  const ctx = el.menu._ctx;
  closeMenu();
  if (ctx.kind === 'biome') ctx.onPick(btn.dataset.biome);
  else {
    const node = addLinked(entryFromButton(btn), ctx);
    if (node && state.mode === 'arch') armCard(node.id);
  }
});

// ---------- pointer interaction ----------

function screenToWorld(cx, cy) {
  const r = el.viewport.getBoundingClientRect();
  const v = curView();
  return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
}

function setSelection(sel) {
  selection = sel;
  for (const n of el.nodes.querySelectorAll('.node')) n.classList.toggle('selected', sel?.kind === 'node' && n.dataset.node === sel.id);
  for (const g of el.edgeLayer.querySelectorAll('.edge')) g.classList.toggle('selected', sel?.kind === 'edge' && g.dataset.edge === sel.id);
}

el.viewport.addEventListener('pointerdown', ev => {
  if (state.mode === 'arch') {
    if (!el.menu.hidden && !el.menu.contains(ev.target)) closeMenu();
    if (ev.target.closest('#arch-card')) return;
    if (archView.pointerDown(ev)) { drag = { kind: 'arch' }; return; }
    if (ev.button !== 0) return;
    drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: state.archView.x, vy: state.archView.y };
    el.viewport.classList.add('panning');
    return;
  }
  if (ev.button !== 0) return;
  if (!el.menu.hidden) closeMenu();
  const port = ev.target.closest('.port');
  if (port) {
    ev.preventDefault();
    const { node, dir } = port.dataset;
    drag = { kind: 'connect', node, item: +port.dataset.item, dir, origin: centerOf(port) };
    return;
  }
  if (ev.target.closest('button, input, select, label')) return;
  const frameTitle = ev.target.closest('.frame-title');
  if (frameTitle) {
    const g = frameTitle.dataset.group;
    const p = screenToWorld(ev.clientX, ev.clientY);
    const fr = state.groups[g]?.frame;
    drag = { kind: 'group', g, frame: fr && { ...fr }, members: state.nodes.filter(n => n.g === g).map(n => ({ n, x: n.x, y: n.y })), sx: p.x, sy: p.y };
    return;
  }
  const nodeEl = ev.target.closest('.node');
  if (nodeEl) {
    const id = nodeEl.dataset.node;
    setSelection({ kind: 'node', id });
    if (ev.target.closest('.node-head')) {
      const n = findNode(id);
      const p = screenToWorld(ev.clientX, ev.clientY);
      // island frames without this card, to see where it is dropped
      const boxes = islandBoxes(id);
      const own = n.g ? boxes.get(n.g) ?? islandBoxes().get(n.g) : null;
      drag = { kind: 'node', n, elem: nodeEl, dx: p.x - n.x, dy: p.y - n.y, boxes, own };
    }
    return;
  }
  const edgeEl = ev.target.closest('.edge');
  if (edgeEl) {
    setSelection({ kind: 'edge', id: edgeEl.dataset.edge });
    return;
  }
  setSelection(null);
  drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: state.view.x, vy: state.view.y };
  el.viewport.classList.add('panning');
});

window.addEventListener('pointermove', ev => {
  if (state?.mode === 'arch' && archView.pointerMove(ev)) return;
  if (!drag) return;
  if (drag.kind === 'pan') {
    const v = curView();
    v.x = drag.vx + ev.clientX - drag.sx;
    v.y = drag.vy + ev.clientY - drag.sy;
    applyView();
  } else if (drag.kind === 'node') {
    const p = screenToWorld(ev.clientX, ev.clientY);
    drag.n.x = Math.round(p.x - drag.dx);
    drag.n.y = Math.round(p.y - drag.dy);
    drag.elem.style.left = `${drag.n.x}px`;
    drag.elem.style.top = `${drag.n.y}px`;
    drag.moved = true;
    scheduleOverlay();
  } else if (drag.kind === 'group') {
    const p = screenToWorld(ev.clientX, ev.clientY);
    for (const m of drag.members) {
      m.n.x = Math.round(m.x + p.x - drag.sx);
      m.n.y = Math.round(m.y + p.y - drag.sy);
      const e = el.nodes.querySelector(`.node[data-node="${m.n.id}"]`);
      if (e) { e.style.left = `${m.n.x}px`; e.style.top = `${m.n.y}px`; }
    }
    if (!drag.members.length && drag.frame) {
      state.groups[drag.g].frame = { x: Math.round(drag.frame.x + p.x - drag.sx), y: Math.round(drag.frame.y + p.y - drag.sy) };
    }
    drag.moved = true;
    scheduleOverlay();
  } else if (drag.kind === 'connect') {
    const p = screenToWorld(ev.clientX, ev.clientY);
    el.temp.setAttribute('d', drag.dir === 'out' ? curve(drag.origin, p) : curve(p, drag.origin));
    for (const t of el.nodes.querySelectorAll('.port.target')) t.classList.remove('target');
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port');
    if (over && canConnect(drag, over)) over.classList.add('target');
  }
});

window.addEventListener('pointerup', ev => {
  if (!drag) return;
  const d = drag;
  drag = null;
  el.viewport.classList.remove('panning');
  if (d.kind === 'arch') { archView.pointerUp(ev); return; }
  if (d.kind === 'node' && d.moved && state.boardView !== 'chain') {
    // dropped into another island's frame: joins it; anywhere else it stays on its island (its frame just grows),
    // unless Alt is held: then a drop outside every frame takes it off the islands
    const cx = d.n.x + NODE_W / 2;
    const cy = d.n.y + 20;
    let g = islandAtBoard(cx, cy, d.boxes, d.n.g);
    if (!g && !(ev.altKey && !inFrame(d.own, cx, cy))) g = d.n.g;
    if (g !== d.n.g) {
      if (g) d.n.g = g; else delete d.n.g;
      commit();
      renderCatalog();
      return;
    }
  }
  if (d.kind === 'pan' || d.moved) save();
  if (d.kind !== 'connect') return;
  el.temp.setAttribute('d', '');
  const target = document.elementFromPoint(ev.clientX, ev.clientY);
  const port = target?.closest('.port');
  if (port) {
    if (canConnect(d, port)) {
      if (d.dir === 'out') addEdge(d.node, port.dataset.node, d.item);
      else addEdge(port.dataset.node, d.node, d.item);
      commit();
    } else {
      render();
    }
    return;
  }
  // Dropped on empty board: offer buildings that make / use this item, placed at the drop point.
  if (target && el.viewport.contains(target) && !target.closest('.node')) {
    const p = screenToWorld(ev.clientX, ev.clientY);
    if (Math.hypot(p.x - d.origin.x, p.y - d.origin.y) < 10) return;
    openMenu({ x: ev.clientX, y: ev.clientY }, { node: d.node, item: d.item, role: d.dir === 'in' ? 'producer' : 'consumer', place: p });
  }
});

function canConnect(from, portEl) {
  return portEl.dataset.dir !== from.dir && +portEl.dataset.item === from.item && portEl.dataset.node !== from.node;
}

el.viewport.addEventListener('wheel', ev => {
  if (ev.target.closest('select, #arch-card')) return;
  ev.preventDefault();
  const r = el.viewport.getBoundingClientRect();
  const mx = ev.clientX - r.left;
  const my = ev.clientY - r.top;
  const v = curView();
  const z0 = v.z;
  const z1 = clamp(z0 * Math.exp(-ev.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
  v.x = mx - (mx - v.x) * (z1 / z0);
  v.y = my - (my - v.y) * (z1 / z0);
  v.z = z1;
  applyView();
  clearTimeout(el.viewport._saveTimer);
  el.viewport._saveTimer = setTimeout(save, 300);
}, { passive: false });

// ---------- node controls ----------

function onCardClick(ev) {
  const port = state.mode === 'arch' ? ev.target.closest('.port') : null;
  if (port) {
    const r = port.getBoundingClientRect();
    openMenu({ x: r.right + 4, y: r.top }, {
      node: port.dataset.node, item: +port.dataset.item, role: port.dataset.dir === 'in' ? 'producer' : 'consumer',
    });
    return;
  }
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const n = findNode(btn.closest('.node').dataset.node);
  if (!n) return;
  const i = +btn.dataset.i;
  switch (btn.dataset.act) {
    case 'inc': n.count += 1; commit(); if (state.mode === 'arch') armCard(n.id); break;
    case 'dec': n.count = Math.max(1, n.count - 1); commit(); break;
    case 'remove': removeNode(n.id); break;
    case 'goal-add': n.items.push({ item: null, amount: 1 }); commit(); break;
    case 'goal-del': n.items.splice(i, 1); pruneEdges(); commit(); break;
    case 'goal-build': buildChain(n.id); break;
    case 'add-producer':
    case 'add-consumer': {
      const r = btn.getBoundingClientRect();
      openMenu({ x: r.right + 4, y: r.top }, {
        node: n.id, item: +btn.dataset.item, role: btn.dataset.act === 'add-producer' ? 'producer' : 'consumer',
      });
      break;
    }
  }
}

function onCardChange(ev) {
  const t = ev.target;
  const act = t.dataset.act;
  const n = findNode(t.closest('.node')?.dataset.node);
  if (!n || !act) return;
  const optional = v => (v === '' ? undefined : +v);
  switch (act) {
    case 'count': n.count = Math.max(1, Math.round(+t.value) || 1); break;
    case 'recipe': {
      const [r, c] = t.value.split('|');
      n.r = parseRecipeId(r);
      if (c) n.c = c; else delete n.c;
      break;
    }
    case 'creatures': n.creatures = +t.value; break;
    case 'lub': n.lub = optional(t.value); break;
    case 'fert': n.fert = optional(t.value); break;
    case 'water': n.water = t.checked; break;
    case 'goal-item': n.items[+t.dataset.i].item = optional(t.value) ?? null; break;
    case 'goal-amount': n.items[+t.dataset.i].amount = Math.max(0, +t.value || 0); break;
    case 'goal-every': n.every = Math.max(0, +t.value) || 1; break;
    case 'goal-per': n.per = t.value; break;
    default: return;
  }
  pruneEdges();
  commit();
}

// Enter in a number field applies it right away.
function onCardKey(ev) {
  if (ev.key === 'Enter' && ev.target.matches('input[type="number"]')) ev.target.blur();
}

for (const host of [el.nodes, el.archCard]) {
  host.addEventListener('click', onCardClick);
  host.addEventListener('change', onCardChange);
  host.addEventListener('keydown', onCardKey);
}

// ---------- catalog, toolbar, keyboard ----------

el.search.addEventListener('input', renderCatalog);
el.summary.addEventListener('mouseover', e => {
  const row = e.target.closest('tr[data-item]');
  el.summary.querySelector('tr.hl')?.classList.remove('hl');
  row?.classList.add('hl');
  setHoverItem(row ? Number(row.dataset.item) : null);
});
el.summary.addEventListener('click', e => {
  const row = e.target.closest('tr[data-item]');
  if (!row) return;
  const item = Number(row.dataset.item);
  if (state.mode === 'arch') { archView.fitItem(item); return; }
  const els = [...el.nodes.querySelectorAll('.node')].filter(nodeEl => {
    const c = calc.nodes.get(nodeEl.dataset.node);
    return c && (c.inputs.has(item) || c.outputs.has(item));
  });
  if (els.length) fitView(els);
});
el.summary.addEventListener('mouseleave', () => {
  el.summary.querySelector('tr.hl')?.classList.remove('hl');
  setHoverItem(null);
});

el.catalog.addEventListener('click', ev => {
  const btn = ev.target.closest('.entry');
  if (!btn) return;
  if (state.mode === 'arch') {
    const armed = archView.armed();
    let what = null;
    if (btn.dataset.node) {
      const n = findNode(btn.dataset.node);
      if (n) what = { b: db.buildings.get(n.b), node: n.id };
    } else if (btn.dataset.infra) {
      what = { b: db.buildings.get(+btn.dataset.infra) };
    } else if (btn.dataset.b) {
      const entry = entryFromButton(btn);
      if (entry) what = { b: entry.b, entry };
    }
    if (what && armed && btn.classList.contains('armed')) archView.disarm();
    else if (what) archView.arm(what);
    return;
  }
  const c = viewCenterWorld();
  const x = c.x - NODE_W / 2;
  let node;
  if (btn.dataset.goal != null) {
    const preset = btn.dataset.goal ? db.goalPresets.find(p => String(p.id) === btn.dataset.goal) : null;
    node = addGoal(preset, x, freeY(x, c.y, 260));
  } else {
    const entry = entryFromButton(btn);
    node = addNode(entry, x, freeY(x, c.y, estimateHeight(entry)));
  }
  const g = state.boardView === 'chain' ? undefined : islandAtBoard(c.x, c.y); // added inside an island's frame
  if (g) node.g = g;
  selection = { kind: 'node', id: node.id };
  commit();
});

el.unit.addEventListener('change', () => { state.unit = el.unit.value; commit(); });

$('btn-fit').addEventListener('click', () => (state.mode === 'arch' ? archView.fit() : fitView()));

el.modeCalc.addEventListener('click', () => setMode('calc'));
el.modeArch.addEventListener('click', () => setMode('arch'));
$('btn-island').addEventListener('click', ev => {
  const r = ev.currentTarget.getBoundingClientRect();
  openBiomeMenu({ x: r.left, y: r.bottom + 4 }, biome => {
    if (state.mode === 'arch') { createIsland(biome); return; }
    // an empty frame below everything on the board, brought into view
    const boxes = [...islandBoxes().values()];
    const bottom = Math.max(0, ...state.nodes.map(n => n.y + heightOf(calc?.nodes.get(n.id))), ...boxes.map(b => b.y1 + 30));
    const left = state.nodes.length || boxes.length ? Math.min(...state.nodes.map(n => n.x), ...boxes.map(b => b.x0)) : 0;
    const frame = { x: Math.round(left), y: Math.round(bottom + 150) };
    createIsland(biome, null, frame);
    const z = state.view.z;
    state.view.x = el.viewport.clientWidth / 2 - (frame.x + NODE_W / 2) * z;
    state.view.y = el.viewport.clientHeight / 2 - (frame.y + 60) * z;
    applyView();
    save();
  });
});

el.frames.addEventListener('click', ev => {
  const btn = ev.target.closest('[data-act="del-island"]');
  if (btn) deleteIsland(btn.closest('.frame-title').dataset.group);
});
el.frames.addEventListener('dblclick', ev => {
  const title = ev.target.closest('.frame-title');
  if (title && !ev.target.closest('button')) renameIsland(title.dataset.group);
});

$('btn-clear').addEventListener('click', () => {
  if (!state.nodes.length && !Object.keys(state.groups).length) return;
  if (!confirm(tk('UI_CONFIRM_CLEAR'))) return;
  state.nodes = [];
  state.edges = [];
  state.groups = {};
  state.placed = [];
  state.props = [];
  state.magnets = [];
  state.saveInfo = null;
  state.layouts = {};
  selection = null;
  commit();
});

el.viewIslands.addEventListener('click', () => setBoardView('islands'));
el.viewChain.addEventListener('click', () => setBoardView('chain'));
$('btn-arrange').addEventListener('click', () => { arrangeBoard(); commit(); fitView(); });

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'novacalc-board.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const s = JSON.parse(await file.text());
    if (!isBoard(s)) throw new Error('not a board');
    setState(s);
    selection = null;
    commit();
    fitView();
  } catch {
    alert(tk('UI_IMPORT_ERROR'));
  }
});

/** Fit the view to the given cards (all cards by default). */
function fitView(els = [...el.nodes.querySelectorAll('.node')]) {
  if (!state) return;
  if (!els.length) {
    state.view = { x: 40, y: 40, z: 1 };
  } else {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const e of els) {
      const n = findNode(e.dataset.node);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y - (n.g ? 56 : 0));
      x1 = Math.max(x1, n.x + e.offsetWidth); y1 = Math.max(y1, n.y + e.offsetHeight);
    }
    state.view = fitBox({ x0, y0, x1, y1 });
  }
  applyView();
  renderOverlay();
  save();
}

window.addEventListener('keydown', ev => {
  if (modsDlg.open) return;
  if (ev.target.closest?.('input, select, textarea')) {
    if (ev.key === 'Escape') ev.target.blur();
    return;
  }
  if (state.mode === 'arch') {
    if (ev.key === 'Escape') closeMenu();
    archView.keyDown(ev);
    return;
  }
  if (ev.key === 'Escape') {
    closeMenu();
    setSelection(null);
  } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selection) {
    ev.preventDefault();
    if (selection.kind === 'node') removeNode(selection.id);
    else removeEdge(selection.id);
  }
});

document.addEventListener('pointerdown', ev => {
  if (!el.menu.hidden && !el.menu.contains(ev.target) && !ev.target.closest('.padd, .slot, #btn-island')) closeMenu();
});

window.addEventListener('resize', scheduleOverlay);

let toastTimer = 0;
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 9000);
}

// ---------- bonuses: skills, gems, save import ----------

const modsDlg = $('mods');

function activeBonuses() {
  const known = new Set(db.productionSkills.map(s => s.id));
  return {
    skills: state.mods.skills.filter(id => known.has(id)).length,
    gems: state.mods.gems.filter(g => db.gems.has(g)).length,
  };
}

function renderModsButton() {
  const a = activeBonuses();
  $('btn-mods').textContent = tk('UI_MODIFIERS_BUTTON', a.skills + a.gems);
}

function renderMods() {
  $('save-hint').textContent = tk('UI_SAVE_HINT', tk('UI_SAVE_PATH'));
  const gemList = [...db.gems.values()].sort((a, b) => a.speedBonus - b.speedBonus);
  $('gem-rows').innerHTML = db.overclockGroups.map((grp, i) => {
    const names = grp.map(id => db.buildings.get(id)).filter(Boolean).map(db.buildingName).join(', ');
    return `<label class="gem-row"><span>${esc(names)}</span><select data-gem="${i}">${optionList(
      [['', tk('UI_NONE')], ...gemList.map(g => [g.item, `${db.itemName(g.item)} (+${pct(g.speedBonus)})`])], state.mods.gems[i])}</select></label>`;
  }).join('');
  const learned = new Set(state.mods.skills);
  $('skill-rows').innerHTML = db.productionSkills.map(s => `<label class="skill-row">
    <input type="checkbox" data-skill="${s.id}"${learned.has(s.id) ? ' checked' : ''}>
    <b>${esc(db.skillName(s))}</b><span class="desc">${esc(db.skillDesc(s))}</span></label>`).join('');
}

function modsChanged() {
  commit();
  renderCatalog(); // catalog shows cycle times under current bonuses
}

$('btn-mods').addEventListener('click', () => {
  renderMods();
  $('save-status').textContent = '';
  modsDlg.showModal();
});
$('mods-close').addEventListener('click', () => modsDlg.close());
modsDlg.addEventListener('click', ev => { if (ev.target === modsDlg) modsDlg.close(); }); // backdrop

modsDlg.addEventListener('change', ev => {
  const t = ev.target;
  if (t.dataset.gem != null) {
    state.mods.gems[+t.dataset.gem] = t.value ? +t.value : null;
  } else if (t.dataset.skill != null) {
    const set = new Set(state.mods.skills);
    if (t.checked) set.add(+t.dataset.skill); else set.delete(+t.dataset.skill);
    state.mods.skills = [...set];
  } else {
    return;
  }
  modsChanged();
});

function applyProfile(profile) {
  state.mods.skills = profile.skills.filter(id => db.skills.has(id));
  if (profile.gems) state.mods.gems = db.overclockGroups.map((_, i) => (db.gems.has(profile.gems[i]) ? profile.gems[i] : null));
}

$('btn-save-import').addEventListener('click', () => $('save-file').click());
$('save-file').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const status = $('save-status');
  try {
    const profile = readProfile(decodeSave(new Uint8Array(await file.arrayBuffer())), db.gemBuildingId);
    applyProfile(profile);
    modsChanged();
    renderMods();
    const a = activeBonuses();
    status.className = '';
    status.textContent = tk('UI_SAVE_DONE', profile.name ?? file.name, profile.day ?? '?', a.skills, a.gems);
  } catch (err) {
    console.error(err);
    status.className = 'error';
    status.textContent = tk('UI_SAVE_ERROR', err.message);
  }
});

// ---------- whole factory from a save ----------

// Not placed on import: the Workbench crafts on demand (its saved recipe is just the last one picked),
// the Animal Cloning Machine is a one-off tool. Generators, farms and production buildings are.
const SKIP_ON_IMPORT = new Set(['MegaPrinter', 'AnimalCloningMachine']);

/**
 * Production buildings and farms of the save, merged into one node per island and setup
 * (building, recipe, creature, lubricant, creatures, fertilizer, watering).
 */
function factoryNodes(save, groups) {
  const merged = new Map();
  let skipped = 0;
  let manual = 0;
  let total = 0;
  for (const rec of readFactory(save)) {
    const b = db.buildings.get(rec.buildingId);
    if (b && SKIP_ON_IMPORT.has(b.key)) { manual++; continue; }
    let entry = null;
    const setup = {};
    if (b?.farm) {
      // a plain plot knows its seed; the Advanced Farm's recipe takes the seed as input
      const seed = rec.seed ?? db.recipes.get(rec.recipeId)?.inputs[0]?.item;
      entry = seed != null ? db.findEntry(b.id, `crop:${seed}`) : null;
      if (entry) {
        if (db.fertilizers.has(rec.fertilizer)) setup.fert = rec.fertilizer;
        if (entry.r.crop.harvest.type !== 'once') setup.water = b.key === 'AdvancedFarmPlot' || !!rec.watered;
      }
    } else if (b?.producedEnergy) {
      entry = db.findEntry(b.id, `gen:${b.id}`);
    } else if (b) {
      const creature = b.maxCreatures
        ? (db.entriesByBuilding.get(b.id) ?? []).find(e => e.r.id === rec.recipeId)?.creature ?? null
        : null;
      entry = db.findEntry(b.id, rec.recipeId, creature?.key);
      if (entry && b.lubricant && db.lubricants.has(rec.lubricant)) setup.lub = rec.lubricant;
      if (entry && b.maxCreatures) setup.creatures = clamp(rec.creatures || 1, 1, b.maxCreatures);
    }
    const g = `i${rec.island.id}`;
    if (!entry || !groups[g]) { skipped++; continue; }
    total++;
    const key = [g, b.id, entry.r.id, entry.creature?.key ?? '', JSON.stringify(setup)].join('|');
    const m = merged.get(key);
    if (m) { m.count++; m.at.push(rec); } else merged.set(key, { entry, setup, g, count: 1, at: [rec] });
  }
  const nodes = [];
  const placed = [];
  const used = new Set(); // save ids of the buildings that became card instances
  for (const m of merged.values()) {
    const n = {
      id: newId('n'), b: m.entry.b.id, r: m.entry.r.id, count: m.count, x: 0, y: 0, g: m.g,
      ...(m.entry.creature ? { c: m.entry.creature.key } : {}),
      ...m.setup,
    };
    nodes.push(n);
    for (const rec of m.at) { placed.push(placedFromSave(rec, m.g, groups, n.id)); used.add(rec.uid); }
  }
  return { nodes, placed, used, total, skipped, manual };
}

const fine = v => Math.round(v * 4096) / 4096;

/** A building of the save as a placed building (position relative to its island's centre). */
function placedFromSave(rec, g, groups, node) {
  const c = hexCenter(groups[g].q, groups[g].r);
  const fixed = groups[g].premade || !editableBuilding(db.buildings.get(rec.buildingId));
  return {
    id: newId('p'), uid: rec.uid, b: rec.buildingId, g, x: fine(rec.x - c.x), y: fine(rec.y - c.y),
    ...(node ? { node } : {}), ...(fixed ? { fixed: true } : {}),
  };
}

/** Islands of the save (not the out-of-map border) with their hex slot; titles from the biome ("Grass Island #2"). */
function islandGroups(islands) {
  const groups = {};
  const seen = new Map();
  for (const isl of islands) {
    if (isl.outOfMap || !db.biomeColors[isl.biome]) continue;
    const base = db.biomeName(isl.biome);
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    const { q, r } = hexAt(isl.x, isl.y);
    groups[`i${isl.id}`] = {
      title: k > 1 ? `${base} #${k}` : base, biome: isl.biome, q, r,
      ...(isl.locked ? { locked: true } : {}), ...(isl.premade ? { premade: true } : {}),
    };
  }
  return groups;
}

/**
 * Connect every producer of an item to every node that takes it (recipe input, lubricant, water, fertilizer).
 * Producers on the same island are preferred; an item nobody makes locally comes from islands whose transporters
 * carry it here (or from any island when none do — the link then shows it has no route).
 */
function linkAll(nodes, groups = state.groups, placed = state.placed) {
  const c = compute({ ...state, nodes, edges: [], groups, placed }, db);
  const producers = new Map();
  for (const n of nodes) {
    for (const item of c.nodes.get(n.id)?.outputs.keys() ?? []) (producers.get(item) ?? producers.set(item, []).get(item)).push(n);
  }
  const edges = [];
  for (const n of nodes) {
    for (const item of c.nodes.get(n.id)?.inputs.keys() ?? []) {
      const all = (producers.get(item) ?? []).filter(p => p !== n);
      const local = all.filter(p => p.g === n.g);
      const routed = all.filter(p => !c.net.enforced(p.g, n.g) || c.net.cap(item, p.g, n.g) > EPS);
      for (const p of local.length ? local : routed.length ? routed : all) edges.push({ id: newId('e'), from: [p.id, item], to: [n.id, item] });
    }
  }
  return edges;
}

/**
 * Layered layout: column = longest chain of suppliers behind a node; rows ordered by their suppliers' rows.
 * `height(node)` gives the card height.
 */
function layoutBoard(nodes, edges, height) {
  const deps = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) deps.get(e.to[0])?.push(e.from[0]);
  const level = new Map();
  const onStack = new Set();
  const depth = id => {
    if (level.has(id)) return level.get(id);
    if (onStack.has(id)) return 0; // cycle (e.g. a refinery making its own lubricant)
    onStack.add(id);
    let l = 0;
    for (const d of deps.get(id) ?? []) l = Math.max(l, depth(d) + 1);
    onStack.delete(id);
    level.set(id, l);
    return l;
  };
  nodes.forEach(n => depth(n.id));

  const cols = [];
  for (const n of nodes) (cols[level.get(n.id)] ??= []).push(n);
  const center = new Map();
  const name = n => (isGoal(n) ? '' : db.buildingName(db.buildings.get(n.b)));
  cols.forEach((col, i) => {
    if (!col) return;
    const bary = n => {
      const ys = deps.get(n.id).map(d => center.get(d)).filter(v => v != null);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : -1e9;
    };
    col.sort((a, b) => bary(a) - bary(b) || name(a).localeCompare(name(b)));
    let y = 0;
    for (const n of col) {
      n.x = i * (NODE_W + GAP_X * 1.5);
      n.y = y;
      y += height(n) + 30;
    }
    const shift = -Math.round(y / 2); // center columns on the same line
    for (const n of col) {
      n.y += shift;
      center.set(n.id, n.y + height(n) / 2);
    }
  });
}

/** Automatic layout of the current calculator view: per island, or the whole chain at once. */
function arrangeBoard() {
  if (state.boardView === 'chain') {
    const c = compute(state, db);
    layoutBoard(state.nodes, state.edges, n => heightOf(c.nodes.get(n.id)));
  } else {
    layoutIslands(state.nodes, state.edges);
  }
}

/**
 * Switch between the island view and the whole chain. Card positions are kept per view; a view seen for the first
 * time is laid out automatically, cards added meanwhile are put next to a linked card.
 */
function setBoardView(view) {
  if ((state.boardView ?? 'islands') === view) return;
  state.layouts = state.layouts ?? {};
  state.layouts[state.boardView ?? 'islands'] = Object.fromEntries(state.nodes.map(n => [n.id, [n.x, n.y]]));
  state.boardView = view;
  const saved = state.layouts[view];
  if (!saved) {
    arrangeBoard();
  } else {
    const missing = [];
    for (const n of state.nodes) {
      if (saved[n.id]) [n.x, n.y] = saved[n.id];
      else missing.push(n);
    }
    const c = compute(state, db);
    const done = new Set(state.nodes.filter(n => saved[n.id]).map(n => n.id));
    for (const n of missing) {
      const link = state.edges.find(e => (e.to[0] === n.id && done.has(e.from[0])) || (e.from[0] === n.id && done.has(e.to[0])));
      const nb = link && findNode(link.to[0] === n.id ? link.from[0] : link.to[0]);
      const h = heightOf(c.nodes.get(n.id));
      if (nb) {
        n.x = nb.x + (link.to[0] === n.id ? NODE_W + GAP_X : -(NODE_W + GAP_X));
        n.y = freeY(n.x, nb.y, h);
      } else {
        n.x = 0;
        n.y = Math.max(0, ...state.nodes.filter(m => done.has(m.id)).map(m => m.y + heightOf(c.nodes.get(m.id)))) + 200;
      }
      done.add(n.id);
    }
  }
  selection = null;
  commit();
  fitView();
}

/** Lay out each island on its own (internal links only), islands stacked top to bottom, biggest first. */
function layoutIslands(nodes, edges) {
  const c = compute({ ...state, nodes, edges }, db);
  const height = n => heightOf(c.nodes.get(n.id));
  const byGroup = new Map();
  for (const n of nodes) (byGroup.get(n.g ?? '') ?? byGroup.set(n.g ?? '', []).get(n.g ?? '')).push(n);
  let top = 0;
  for (const list of [...byGroup.values()].sort((a, b) => b.length - a.length)) {
    const ids = new Set(list.map(n => n.id));
    layoutBoard(list, edges.filter(e => ids.has(e.from[0]) && ids.has(e.to[0])), height);
    const minX = Math.min(...list.map(n => n.x));
    const minY = Math.min(...list.map(n => n.y));
    const maxY = Math.max(...list.map(n => n.y + height(n)));
    for (const n of list) { n.x -= minX; n.y += top - minY; }
    top += maxY - minY + 180;
  }
}

$('btn-factory').addEventListener('click', () => $('factory-file').click());
$('factory-file').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const save = decodeSave(text);
    if (state.nodes.length && !confirm(tk('UI_FACTORY_REPLACE'))) return;
    nextId = 1;
    const profile = readProfile(save, db.gemBuildingId);
    applyProfile(profile);
    const layout = readLayout(save);
    const groups = islandGroups(layout.islands);
    const { nodes, placed, used, total, skipped, manual } = factoryNodes(save, groups);
    // everything else standing on the islands: storage, logistics, workbenches, NPCs, …
    const byUid = new Map();
    for (const b of layout.buildings) {
      const g = `i${b.islandId}`;
      if (used.has(b.uid) || !groups[g] || !db.buildings.has(b.buildingId)) continue;
      const p = placedFromSave(b, g, groups, null);
      if (b.twin != null) { // transporter arm: shore slot + the arm on the facing island
        const slot = slotAt(p.x, p.y);
        if (slot >= 0) { p.slot = slot; p.x = TRANSPORTER_SLOTS[slot][0]; p.y = TRANSPORTER_SLOTS[slot][1]; }
        p.twinUid = b.twin;
        if (b.item != null) p.item = b.item;
      }
      if ((b.buildingId === db.droneBaseId || b.buildingId === db.itemAntennaId) && b.item != null) p.item = b.item;
      if (b.buildingId === db.droneBaseId) p.targetUids = b.targets ?? [];
      byUid.set(b.uid, p);
      placed.push(p);
    }
    for (const p of placed) {
      if (p.targetUids) { p.targets = p.targetUids.map(u => byUid.get(u)?.id).filter(Boolean); delete p.targetUids; }
      if (p.twinUid == null) continue;
      const t = byUid.get(p.twinUid);
      if (t) p.twin = t.id;
      delete p.twinUid;
    }
    for (const p of placed) byUid.set(p.uid, p); // production buildings too, for the magnetoids
    const magnets = [];
    for (const m of layout.magnets) {
      const a = byUid.get(m.origin); const c = byUid.get(m.target);
      if (a && c) magnets.push({ id: newId('m'), uid: m.uid, from: a.id, to: c.id, fs: m.originSlot, ts: m.targetSlot });
    }
    const props = [];
    for (const pr of layout.props) {
      const g = `i${pr.islandId}`;
      if (!groups[g] || !db.props.has(pr.propId)) continue;
      const c = hexCenter(groups[g].q, groups[g].r);
      props.push({ id: newId('r'), uid: pr.uid, b: pr.propId, g, x: fine(pr.x - c.x), y: fine(pr.y - c.y) });
    }
    const hash = storeSave(file.name, text);
    const edges = linkAll(nodes, groups, placed);
    state.nodes = nodes;
    state.edges = edges;
    state.groups = groups;
    state.placed = placed;
    state.props = props;
    state.magnets = magnets;
    state.saveInfo = hash ? {
      file: file.name, name: profile.name, day: profile.day, hash, logistics: true,
      types: [...new Set(layout.buildings.map(b => b.buildingId))],
    } : null;
    state.layouts = {};
    arrangeBoard();
    selection = null;
    pruneEdges();
    commit();
    renderCatalog();
    if (state.mode === 'arch') archView.fit(); else fitView();
    toast(tk('UI_FACTORY_DONE', profile.name ?? file.name, profile.day ?? '?', total, new Set(nodes.map(n => n.g)).size,
      nodes.length, state.edges.length, skipped, manual));
  } catch (err) {
    console.error(err);
    toast(tk('UI_SAVE_ERROR', err.message), true);
  }
});

// ---------- writing the layout back into the save ----------

/** FNV-1a of a string, to tell whether the stored save is the one the board came from. */
function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16) + text.length.toString(16);
}

/** Keep the imported save (browser storage) for writing it back; returns its hash or null when it doesn't fit. */
function storeSave(file, text) {
  const hash = textHash(text);
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ file, text, hash })); } catch { return null; }
  return hash;
}
function storedSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return null; }
}

el.saveOut.addEventListener('click', () => {
  const stored = storedSave();
  if (!state.saveInfo || stored?.hash !== state.saveInfo.hash) { toast(tk('UI_SAVE_OUT_MISSING'), true); return; }
  try {
    const root = readTree(stored.text);
    const sum = applyLayout(root, {
      placed: state.placed, props: state.props, nodes: state.nodes, groups: state.groups,
      magnets: state.saveInfo.logistics ? state.magnets : undefined, // boards imported before magnetoids were read
      db: { buildings: db.buildings, footprintOf, magnetAntennaId: db.magnetAntennaId }, hexAt,
    });
    const unplaced = state.nodes.reduce((k, n) => k + unplacedCount(n.id), 0);
    const skipped = sum.skipped.length;
    const changes = sum.moved + sum.transferred + sum.added + sum.deleted + sum.recipes + sum.items + sum.props + sum.drones + sum.magnets;
    if (!changes) { toast(tk('UI_SAVE_OUT_NOTHING')); return; }
    if (!confirm(tk('UI_SAVE_OUT_CONFIRM', stored.file, sum.added, sum.moved, sum.transferred, sum.deleted, sum.recipes,
      sum.items, sum.props, unplaced, skipped, sum.drones, sum.magnets))) return;
    const blob = new Blob([writeTree(root)], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = stored.file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(tk('UI_SAVE_OUT_DONE', stored.file));
  } catch (err) {
    console.error(err);
    toast(tk('UI_SAVE_ERROR', err.message), true);
  }
});

// ---------- start ----------

async function init() {
  await loadLocale('en');
  db = await loadData();
  applyStaticTexts();
  archView = createArch({
    el: { root: el.arch, hexes: el.archHexes, labels: el.archLabels, blds: el.archBlds, links: el.archLinks, card: el.archCard },
    cardHtml: id => { const n = findNode(id); return n && !isGoal(n) ? nodeHtml(n) : ''; },
    state: () => state, calc: () => calc, db, tk, esc, iconHtml, EPS,
    toWorld: screenToWorld, hoverItem: () => hoverItem,
    setView(box) { state.archView = fitBox(box, 2); applyView(); save(); },
    onArmChange: markArmed,
    toast,
    ops: placeOps,
  });
  setState(loadState() ?? emptyState());
  renderCatalog();
  render();
}

init().catch(err => {
  console.error(err);
  document.body.textContent = `Failed to start: ${err.message}`;
});
