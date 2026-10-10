// Architect view: islands as hexagons on the world grid, buildings at their real size and position.
// Pure rendering + pointer handling; every change of the model goes through ctx.ops (main.js).
import {
  RY, hexCenter, hexAt, hexSlots, hexCorners, footprintOf, rectAt, snapPosition, canPlace,
  TRANSPORTER_SLOTS, slotPair, nearestSlot,
} from './world.js';

export const U = 32; // screen px per world unit at zoom 1
const SLOT_RINGS = 2;
const DRAW_SCALE = 0.965; // hexagons tile exactly; draw them a bit smaller for the gaps the game's map shows
const ARM_REACH = 2.5;    // how close to a shore slot the pointer must be to place a transporter arm

/**
 * ctx: { el: { root, hexes, labels, blds, links, card }, state(), calc(), db, tk, esc, iconHtml, EPS,
 *        toWorld(clientX, clientY) -> px in the architect layer, setView(box), hoverItem(), cardHtml(nodeId),
 *        onArmChange(armed), ops: {...} }
 */
export function createArch(ctx) {
  const { el, db, tk, esc } = ctx;
  let armed = null;    // what a click places: { b, entry?, node? }
  let drag = null;     // moving a placed building ({ p }) or a prop ({ prop })
  let selected = null; // placed id
  let ghost = null;

  const S = () => ctx.state();
  const toUnits = (cx, cy) => { const p = ctx.toWorld(cx, cy); return { x: p.x / U, y: -p.y / U }; };
  const islandsWithHex = () => Object.entries(S().groups).filter(([, g]) => g.q != null && g.r != null);
  const isArm = b => !!b?.key?.startsWith('TransporterContainer');
  const groupAt = (q, r) => islandsWithHex().find(([, g]) => g.q === q && g.r === r)?.[0];
  const centerOf = g => { const isl = S().groups[g]; return hexCenter(isl.q, isl.r); };

  /** Island under a world point: { g, center, x, y } (x, y relative to its centre) or null. */
  function islandAt(pt) {
    const { q, r } = hexAt(pt.x, pt.y);
    const g = groupAt(q, r);
    if (!g) return null;
    const center = hexCenter(q, r);
    return { g, center, x: pt.x - center.x, y: pt.y - center.y };
  }

  /** A prop as a building-like thing for the placement checks: its collider box is the footprint. */
  const propBox = id => ({ footprint: db.props.get(id)?.box ?? { w: 0.8, h: 0.8, x: 0, y: 0.3 } });
  const propsOf = st => st.props ?? [];

  // buildings and props (rocks, bushes, trees) of island g: a building may not cover either
  const othersOn = (g, except) => [
    ...S().placed.filter(p => p.g === g && !except.includes(p.id)).map(p => ({ b: db.buildings.get(p.b), x: p.x, y: p.y })),
    ...propsOf(S()).filter(p => p.g === g && !except.includes(p.id)).map(p => ({ b: propBox(p.b), x: p.x, y: p.y })),
  ];
  const premade = g => !!S().groups[g]?.premade;

  /** Snapped spot for building `b` with its footprint centred at world point `pt`. */
  function spotFor(b, pt, except = []) {
    const isl = islandAt(pt);
    if (!isl) return null;
    const pos = snapPosition(b, isl.center, isl.x, isl.y);
    return { ...isl, ...pos, ok: !premade(isl.g) && canPlace(b, pos.x, pos.y, othersOn(isl.g, except)) };
  }

  /** A prop dragged to world point pt on its own island g: free position, on the ground, off the buildings. */
  function propSpot(prop, pt) {
    const center = centerOf(prop.g);
    const step = 1 / 32;
    const x = Math.round((pt.x - center.x) / step) * step;
    const y = Math.round((pt.y - center.y) / step) * step;
    const buildings = S().placed.filter(p => p.g === prop.g).map(p => ({ b: db.buildings.get(p.b), x: p.x, y: p.y }));
    return { g: prop.g, center, x, y, ok: canPlace(propBox(prop.b), x, y, buildings) };
  }

  /**
   * Transporter arm spot: the shore slot of island g nearest to (x, y) (relative to its centre) and its pair on the
   * neighbouring island. ok = both slots free and the neighbour exists.
   */
  function armSpot(g, center, x, y, except = []) {
    const near = nearestSlot(x, y);
    const pair = slotPair(near.slot);
    const { q, r } = hexAt(center.x + pair.dx, center.y + pair.dy);
    const g2 = groupAt(q, r);
    const taken = (gg, slot) => S().placed.some(p => p.g === gg && p.slot === slot && !except.includes(p.id));
    const [sx, sy] = TRANSPORTER_SLOTS[near.slot];
    return {
      g, center, slot: near.slot, x: sx, y: sy, dist: near.dist, g2, slot2: pair.slot,
      ok: !!g2 && !taken(g, near.slot) && !taken(g2, pair.slot) && !premade(g) && !premade(g2),
    };
  }

  // ---------- rendering ----------

  const pts = (cx, cy) => hexCorners().map(([x, y]) => `${(cx + x * DRAW_SCALE) * U},${-(cy + y * DRAW_SCALE) * U}`).join(' ');

  /** Footprint centre of a placed building in layer px. */
  function pxCenter(p) {
    const c = centerOf(p.g);
    const f = footprintOf(db.buildings.get(p.b));
    return { x: (c.x + p.x + f.x) * U, y: -(c.y + p.y + f.y) * U };
  }

  function render() {
    const st = S();
    const calc = ctx.calc();
    if (selected && !st.placed.some(p => p.id === selected)) selected = null;
    const used = new Set();
    let hexes = '';
    let labels = '';
    for (const [g, isl] of islandsWithHex()) {
      used.add(`${isl.q},${isl.r}`);
      const c = hexCenter(isl.q, isl.r);
      const col = db.biomeColors[isl.biome] ?? { ground: '#8a919c', border: null };
      const tip = isl.premade ? tk('UI_ARCH_PREMADE') : tk('UI_ARCH_ISLAND_TITLE');
      hexes += `<polygon class="island${isl.locked ? ' locked' : ''}" data-group="${esc(g)}" points="${pts(c.x, c.y)}"
        style="fill:${col.ground};stroke:${col.border ?? col.ground}"><title>${esc(isl.title)} · ${esc(tip)}</title></polygon>`;
      // title along the top edge, energy along the bottom one
      labels += `<div class="arch-title" style="left:${c.x * U}px;top:${-(c.y + RY * DRAW_SCALE) * U + 12}px">${isl.locked ? '🔒 ' : ''}${esc(isl.title)}<button class="icon" data-act="del-island" data-group="${esc(g)}" title="${esc(tk('UI_ISLAND_DELETE'))}">×</button></div>`;
      const e = calc?.energyByGroup.get(g);
      if (e && (e.used || e.made)) {
        labels += `<div class="arch-energy${e.used > e.made ? ' neg' : ''}" style="left:${c.x * U}px;top:${-(c.y - RY * DRAW_SCALE) * U - 12}px"
          title="${esc(tk('UI_ENERGY_TITLE'))}">⚡ ${e.used} / ${e.made}</div>`;
      }
    }
    for (const { q, r } of hexSlots(SLOT_RINGS)) {
      if (used.has(`${q},${r}`)) continue;
      const c = hexCenter(q, r);
      hexes += `<g class="slot" data-q="${q}" data-r="${r}"><title>${esc(tk('UI_ISLAND_NEW_TITLE'))}</title>
        <polygon points="${pts(c.x, c.y)}"/><text x="${c.x * U}" y="${-c.y * U}">+</text></g>`;
    }
    el.hexes.innerHTML = hexes;

    const sel = st.placed.find(p => p.id === selected);
    let blds = '';
    for (const p of propsOf(st)) { // rocks, bushes, trees: under the buildings
      const isl = st.groups[p.g];
      if (!isl || isl.q == null) continue;
      const c = hexCenter(isl.q, isl.r);
      const r = rectAt(propBox(p.b), p.x, p.y);
      const w = (r.x1 - r.x0) * U;
      const h = (r.y1 - r.y0) * U;
      const size = Math.max(8, Math.floor(Math.min(w, h)));
      blds += `<div class="pp${isl.premade ? ' fixed' : ''}" data-prop="${esc(p.id)}" style="left:${(c.x + r.x0) * U}px;top:${-(c.y + r.y1) * U}px;width:${w}px;height:${h}px"
        title="${esc(db.propName(db.props.get(p.b)))}">${ctx.iconHtml('props', p.b, size)}</div>`;
    }
    for (const p of st.placed) {
      const isl = st.groups[p.g];
      if (!isl || isl.q == null) continue;
      const b = db.buildings.get(p.b);
      const c = hexCenter(isl.q, isl.r);
      const r = rectAt(b, p.x, p.y);
      const w = (r.x1 - r.x0) * U;
      const h = (r.y1 - r.y0) * U;
      const cn = p.node != null ? calc?.nodes.get(p.node) : null;
      const status = p.node == null ? 'infra' : cn && cn.coverage < 1 - ctx.EPS ? 'prod short' : 'prod';
      const recipe = cn ? db.entryLabel({ b, r: cn.r, creature: cn.n.c ? db.creatures.get(cn.n.c) : null }) : '';
      const carried = isArm(b) ? armItem(p) : null; // transporter arms show what they carry
      const what = recipe || (carried != null ? db.itemName(carried) : '');
      const label = b ? `${db.buildingName(b)}${what ? `\n${what}` : ''}` : `#${p.b}`;
      // production shows what it makes; everything else its own picture
      const out = cn?.r.outputs[0]?.item;
      const size = Math.max(8, Math.min(96, Math.floor(Math.min(w, h) * 0.8)));
      const icon = carried != null ? ctx.iconHtml('items', carried, size)
        : out != null && !cn.gen ? ctx.iconHtml('items', out, size) : ctx.iconHtml('buildings', p.b, size);
      const extra = (p.id === selected ? ' selected' : '') + (sel?.twin === p.id ? ' twin' : '') + (isArm(b) ? ' arm' : '')
        + (p.fixed ? ' fixed' : '');
      const title = p.fixed ? `${label}\n${tk('UI_ARCH_FIXED')}` : label;
      blds += `<div class="pb ${status}${extra}" data-p="${esc(p.id)}"${p.node != null ? ` data-node="${esc(p.node)}"` : ''}
        style="left:${(c.x + r.x0) * U}px;top:${-(c.y + r.y1) * U}px;width:${w}px;height:${h}px" title="${esc(title)}">${icon}</div>`;
    }
    el.blds.innerHTML = blds + '<div id="arch-ghost" hidden></div>';
    ghost = el.blds.querySelector('#arch-ghost');
    labels += renderLinks(sel);
    el.labels.innerHTML = labels;
    applyHighlight(ctx.hoverItem());
    renderCard(sel);
  }

  /** Transporter bridges, and for the selected building lines to the buildings that supply it / take its output. */
  function renderLinks(sel) {
    const st = S();
    const calc = ctx.calc();
    const byId = new Map(st.placed.map(p => [p.id, p]));
    const live = p => p && st.groups[p.g]?.q != null;
    let svg = '';
    let icons = '';
    for (const p of st.placed) {
      const t = p.twin && byId.get(p.twin);
      if (!live(p) || !live(t) || db.buildings.get(p.b)?.key !== 'TransporterContainerInput') continue;
      const a = pxCenter(p);
      const b = pxCenter(t);
      svg += `<line class="bridge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#arch-arrow)"/>`;
    }
    if (sel?.node != null && live(sel)) {
      const a = pxCenter(sel);
      for (const e of st.edges) {
        const out = e.from[0] === sel.node;
        if (!out && e.to[0] !== sel.node) continue;
        const other = out ? e.to[0] : e.from[0];
        let near = null;
        for (const q of st.placed) {
          if (q.node !== other || !live(q)) continue;
          const b = pxCenter(q);
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          // suppliers green, consumers orange (like the summary highlight); red dashes: no transporter for it
          const ce = calc?.edges.find(x => x.e === e);
          const noRoute = ce?.transport && ce.transport.cap <= ctx.EPS ? ' noroute' : '';
          svg += `<line class="link ${out ? 'out' : 'in'}${noRoute}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
          if (!near || d < near.d) near = { b, d };
        }
        if (near) {
          icons += `<div class="link-ico ${out ? 'out' : 'in'}" style="left:${(a.x + near.b.x) / 2}px;top:${(a.y + near.b.y) / 2}px"
            title="${esc(db.itemName(e.from[1]))}">${ctx.iconHtml('items', e.from[1], 24)}</div>`;
        }
      }
    }
    el.links.innerHTML = `<defs><marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"/></marker></defs>${svg}`;
    return icons;
  }

  /** Item a transporter carries (set on its input arm). */
  function armItem(p) {
    if (p.item != null) return p.item;
    return S().placed.find(q => q.id === p.twin)?.item ?? null;
  }

  /** Small panel for a transporter: which item it carries. */
  function armCardHtml(p) {
    const cur = armItem(p);
    const options = [`<option value="">${esc(tk('UI_CHOOSE_ITEM'))}</option>`,
      ...db.itemsByName.map(it => `<option value="${it.id}"${it.id === cur ? ' selected' : ''}>${esc(db.itemName(it.id))}</option>`)].join('');
    return `<div class="node arm-card"><div class="node-head">${ctx.iconHtml('buildings', p.b, 24)}<span class="node-title">${esc(db.buildingName(db.buildings.get(p.b)))}</span></div>
      <div class="node-body"><label class="opt">${esc(tk('UI_ARM_ITEM'))}<select data-act="arm-item" data-p="${esc(p.id)}">${options}</select></label></div></div>`;
  }

  el.card.addEventListener('change', ev => {
    const t = ev.target.closest('[data-act="arm-item"]');
    if (t) ctx.ops.setArmItem(t.dataset.p, t.value === '' ? null : +t.value);
  });

  /** The selected building's card from the calculator (or a transporter's item), next to it on screen. */
  function renderCard(sel) {
    const html = sel?.node != null ? ctx.cardHtml(sel.node) : sel && isArm(db.buildings.get(sel.b)) ? armCardHtml(sel) : '';
    el.card.innerHTML = html;
    el.card.hidden = !html;
    placeCard();
  }

  function placeCard() {
    if (el.card.hidden || !selected) return;
    const pbEl = el.blds.querySelector(`.pb[data-p="${CSS.escape(selected)}"]`);
    if (!pbEl) return;
    const r = pbEl.getBoundingClientRect();
    const vp = el.card.offsetParent.getBoundingClientRect();
    const w = el.card.offsetWidth;
    const h = el.card.offsetHeight;
    let left = r.right - vp.left + 16;
    if (left + w > vp.width - 8) left = r.left - vp.left - w - 16;
    el.card.style.left = `${Math.max(8, left)}px`;
    el.card.style.top = `${Math.min(Math.max(8, r.top - vp.top), Math.max(8, vp.height - h - 8))}px`;
  }

  /** Summary hover: buildings whose card makes (hl-out) or uses (hl-in) the item. */
  function applyHighlight(item) {
    const calc = ctx.calc();
    el.blds.classList.toggle('hl', item != null);
    for (const e of el.blds.querySelectorAll('.pb')) {
      const c = e.dataset.node ? calc?.nodes.get(e.dataset.node) : null;
      e.classList.toggle('hl-out', item != null && !!c?.outputs.has(item));
      e.classList.toggle('hl-in', item != null && !!c?.inputs.has(item));
    }
  }

  function showGhost(b, spot) { // b: a building, or a prop's propBox
    if (!ghost) return;
    if (!spot) { ghost.hidden = true; return; }
    const r = rectAt(b, spot.x, spot.y);
    Object.assign(ghost.style, {
      left: `${(spot.center.x + r.x0) * U}px`, top: `${-(spot.center.y + r.y1) * U}px`,
      width: `${(r.x1 - r.x0) * U}px`, height: `${(r.y1 - r.y0) * U}px`,
    });
    ghost.className = spot.ok ? 'ok' : 'bad';
    ghost.hidden = false;
  }

  /** Where the armed building would go for pointer world point pt. */
  function armedSpot(pt) {
    if (isArm(armed.b)) {
      const isl = islandAt(pt);
      if (!isl) return null;
      const s = armSpot(isl.g, isl.center, isl.x, isl.y);
      return s.dist <= ARM_REACH ? s : null;
    }
    return spotFor(armed.b, pt);
  }

  // ---------- placing ----------

  /** Arm placement: next clicks on an island place this building. */
  function arm(what) {
    armed = what;
    el.root.classList.add('armed');
    ctx.onArmChange?.(armed);
  }
  function disarm() {
    armed = null;
    el.root.classList.remove('armed');
    if (ghost) ghost.hidden = true;
    ctx.onArmChange?.(null);
  }

  // ---------- pointer ----------

  /** Returns true when the architect handled the event (otherwise the board pans). */
  function pointerDown(ev) {
    if (ev.button === 2 && armed) { disarm(); return true; }
    if (ev.button !== 0) return false;
    const del = ev.target.closest('[data-act="del-island"]');
    if (del) { ctx.ops.deleteIsland(del.dataset.group); return true; }
    const pt = toUnits(ev.clientX, ev.clientY);
    if (armed) {
      const spot = armedSpot(pt);
      if (!spot) return false;
      if (spot.ok) {
        const isNewArm = isArm(armed.b);
        const id = isNewArm ? ctx.ops.placeTransporter(spot.g, spot.slot) : ctx.ops.place(armed, spot.g, spot.x, spot.y);
        // a card's buildings: keep placing until all are on the map; anything else: Shift keeps placing
        if (armed?.node ? !ctx.ops.unplacedCount(armed.node) : !ev.shiftKey) disarm();
        if (isNewArm && id && !armed) select(id); // a new transporter: pick what it carries right away
      }
      return true;
    }
    const slot = ev.target.closest('.slot');
    if (slot) {
      ctx.ops.newIsland({ x: ev.clientX, y: ev.clientY }, { q: +slot.dataset.q, r: +slot.dataset.r });
      return true;
    }
    const pbEl = ev.target.closest('.pb');
    if (pbEl) {
      const p = S().placed.find(x => x.id === pbEl.dataset.p);
      if (!p) return false;
      select(p.id); // re-renders: take the new element
      if (p.fixed) return true; // NPCs, landmarks: select only
      const elem = el.blds.querySelector(`.pb[data-p="${CSS.escape(p.id)}"]`) ?? pbEl;
      const c = centerOf(p.g);
      const f = footprintOf(db.buildings.get(p.b));
      drag = { p, elem, dx: pt.x - (c.x + p.x + f.x), dy: pt.y - (c.y + p.y + f.y), sx: ev.clientX, sy: ev.clientY };
      return true;
    }
    const ppEl = ev.target.closest('.pp:not(.fixed)');
    if (ppEl) {
      const prop = (S().props ?? []).find(x => x.id === ppEl.dataset.prop);
      if (!prop) return false;
      select(null);
      const elem = el.blds.querySelector(`.pp[data-prop="${CSS.escape(prop.id)}"]`) ?? ppEl;
      const c = centerOf(prop.g);
      drag = { prop, elem, dx: pt.x - (c.x + prop.x), dy: pt.y - (c.y + prop.y), sx: ev.clientX, sy: ev.clientY };
      return true;
    }
    select(null);
    return false;
  }

  function pointerMove(ev) {
    if (drag?.prop) {
      if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return true;
      drag.moved = true;
      drag.elem.classList.add('dragging');
      const pt = toUnits(ev.clientX, ev.clientY);
      drag.spot = propSpot(drag.prop, { x: pt.x - drag.dx, y: pt.y - drag.dy });
      showGhost(propBox(drag.prop.b), drag.spot);
      return true;
    }
    if (drag) {
      if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return true;
      drag.moved = true;
      drag.elem.classList.add('dragging');
      const pt = toUnits(ev.clientX, ev.clientY);
      const b = db.buildings.get(drag.p.b);
      if (isArm(b)) {
        // arms only slide along their own island's shore; the twin follows on the facing island
        const c = centerOf(drag.p.g);
        drag.spot = armSpot(drag.p.g, c, pt.x - drag.dx - c.x, pt.y - drag.dy - c.y, [drag.p.id, drag.p.twin]);
      } else {
        drag.spot = spotFor(b, { x: pt.x - drag.dx, y: pt.y - drag.dy }, [drag.p.id]);
      }
      showGhost(b, drag.spot);
      return true;
    }
    if (armed) {
      showGhost(armed.b, armedSpot(toUnits(ev.clientX, ev.clientY)));
      return false; // the board may still be panning
    }
    return false;
  }

  function pointerUp() {
    if (!drag) return false;
    const d = drag;
    drag = null;
    if (ghost) ghost.hidden = true;
    d.elem.classList.remove('dragging');
    if (d.moved && d.spot?.ok) {
      if (d.prop) ctx.ops.moveProp(d.prop.id, d.spot.x, d.spot.y);
      else if (d.spot.slot != null) ctx.ops.moveTransporter(d.p.id, d.spot.slot);
      else ctx.ops.move(d.p.id, d.spot.g, d.spot.x, d.spot.y);
    }
    return true;
  }

  function select(id) {
    if (selected === id) return;
    selected = id;
    render();
  }

  function keyDown(ev) {
    if (ev.key === 'Escape') { if (armed) disarm(); else select(null); return true; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected) {
      ev.preventDefault();
      if (S().placed.find(p => p.id === selected)?.fixed) return true;
      const id = selected;
      selected = null;
      ctx.ops.remove(id);
      return true;
    }
    return false;
  }

  el.root.addEventListener('dblclick', ev => {
    const island = ev.target.closest('.island'); // double click on the island's ground: rename it
    if (island) { ctx.ops.renameIsland(island.dataset.group); return; }
    const pbEl = ev.target.closest('.pb[data-node]');
    if (pbEl) ctx.ops.focusCard(pbEl.dataset.node);
  });
  el.root.addEventListener('contextmenu', ev => { if (armed) { ev.preventDefault(); disarm(); } });

  // ---------- view ----------

  /** Fit the view to world rectangles [{x0, y0, x1, y1}] (units), or to every island. */
  function fit(rects) {
    let list = rects;
    if (!list?.length) {
      const isl = islandsWithHex();
      const centers = (isl.length ? isl.map(([, g]) => hexCenter(g.q, g.r)) : hexSlots(SLOT_RINGS).map(s => hexCenter(s.q, s.r)));
      list = centers.map(c => ({ x0: c.x - 12, x1: c.x + 12, y0: c.y - RY, y1: c.y + RY }));
    }
    const x0 = Math.min(...list.map(r => r.x0)) * U;
    const x1 = Math.max(...list.map(r => r.x1)) * U;
    const y0 = -Math.max(...list.map(r => r.y1)) * U;
    const y1 = -Math.min(...list.map(r => r.y0)) * U;
    ctx.setView({ x0, y0, x1, y1 });
  }

  /** Fit to the buildings whose card makes or uses `item`. */
  function fitItem(item) {
    const calc = ctx.calc();
    const rects = [];
    for (const p of S().placed) {
      const c = p.node != null ? calc?.nodes.get(p.node) : null;
      if (!c || !(c.inputs.has(item) || c.outputs.has(item)) || S().groups[p.g]?.q == null) continue;
      const cc = centerOf(p.g);
      const r = rectAt(db.buildings.get(p.b), p.x, p.y);
      rects.push({ x0: cc.x + r.x0 - 1, x1: cc.x + r.x1 + 1, y0: cc.y + r.y0 - 1, y1: cc.y + r.y1 + 1 });
    }
    if (rects.length) fit(rects);
  }

  return {
    render, applyHighlight, pointerDown, pointerMove, pointerUp, keyDown, arm, disarm, fit, fitItem, placeCard,
    armed: () => armed, select,
  };
}
