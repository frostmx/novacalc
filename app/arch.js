// Architect view: islands as hexagons on the world grid, buildings at their real size and position.
// Pure rendering + pointer handling; every change of the model goes through ctx.ops (main.js).
import {
  RY, hexCenter, hexAt, hexSlots, hexCorners, footprintOf, rectAt, snapPosition, canPlace,
  TRANSPORTER_SLOTS, slotPair, nearestSlot, magnetSlotAt,
} from './world.js';

export const U = 32; // screen px per world unit at zoom 1
const SLOT_RINGS = 2;
const DRAW_SCALE = 0.965; // hexagons tile exactly; draw them a bit smaller for the gaps the game's map shows
const ARM_REACH = 2.5;    // how close to a shore slot the pointer must be to place a transporter arm
const CARD_GAP = 56;      // px between the selected building and its card
const CARD_OFFSET_KEY = 'novacalc.archCardOffset';
// delete buttons (cards, islands): a red bin, so they don't read as "close"
export const TRASH = '<svg class="trash" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5h4M2.5 3.5h11M4 3.5l.7 10a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-10M6.5 6.5v5M9.5 6.5v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * ctx: { el: { root, hexes, labels, blds, links, card }, state(), calc(), db, tk, esc, iconHtml, EPS,
 *        toWorld(clientX, clientY) -> px in the architect layer, setView(box), hoverItem(), cardHtml(nodeId),
 *        onArmChange(armed), toast(text, bad), ops: {...} }
 */
export function createArch(ctx) {
  const { el, db, tk, esc } = ctx;
  let armed = null;    // what a click places: { b, entry?, node? }
  let drag = null;     // moving a placed building ({ p }) or a prop ({ prop })
  let selected = null; // placed id
  let selMagnet = null; // magnetoid id
  let picking = null;  // { kind: 'target' | 'magnet', from }: the next click on a building picks it
  let ghost = null;

  const S = () => ctx.state();
  const toUnits = (cx, cy) => { const p = ctx.toWorld(cx, cy); return { x: p.x / U, y: -p.y / U }; };
  const islandsWithHex = () => Object.entries(S().groups).filter(([, g]) => g.q != null && g.r != null);
  const isArm = b => !!b?.key?.startsWith('TransporterContainer');
  // buildings that carry one chosen item: transporter arms, drone bases, item antennas
  const carries = b => isArm(b) || (b && (b.id === db.droneBaseId || b.id === db.itemAntennaId));
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
    if (selMagnet && !(st.magnets ?? []).some(m => m.id === selMagnet)) selMagnet = null;
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
      labels += `<div class="arch-title" style="left:${c.x * U}px;top:${-(c.y + RY * DRAW_SCALE) * U + 12}px">${isl.locked ? '🔒 ' : ''}${esc(isl.title)}<button class="icon del" data-act="del-island" data-group="${esc(g)}" title="${esc(tk('UI_ISLAND_DELETE'))}">${TRASH}</button></div>`;
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
      const status = p.node == null ? 'infra' : cn?.empty ? 'prod no-recipe' : cn && cn.coverage < 1 - ctx.EPS ? 'prod short' : 'prod';
      const recipe = !cn ? '' : cn.empty ? tk('UI_NO_RECIPE') : db.entryLabel({ b, r: cn.r, creature: cn.n.c ? db.creatures.get(cn.n.c) : null });
      const carried = carries(b) ? armItem(p) : null; // arms, drone bases, item antennas show what they carry
      const what = recipe || (carried != null ? db.itemName(carried) : '');
      const label = b ? `${db.buildingName(b)}${what ? `\n${what}` : ''}` : `#${p.b}`;
      // production shows what it makes; everything else its own picture
      const out = cn?.r.outputs[0]?.item;
      const size = Math.max(8, Math.min(96, Math.floor(Math.min(w, h) * 0.8)));
      const icon = carried != null ? ctx.iconHtml('items', carried, size)
        : out != null && !cn.gen ? ctx.iconHtml('items', out, size) : ctx.iconHtml('buildings', p.b, size);
      const extra = (p.id === selected ? ' selected' : '') + (sel?.twin === p.id || sel?.targets?.includes(p.id) ? ' twin' : '')
        + (carries(b) ? ' arm' : '') + (p.fixed ? ' fixed' : '');
      const title = p.fixed ? `${label}\n${tk('UI_ARCH_FIXED')}` : label;
      blds += `<div class="pb ${status}${extra}" data-p="${esc(p.id)}"${p.node != null ? ` data-node="${esc(p.node)}"` : ''}
        style="left:${(c.x + r.x0) * U}px;top:${-(c.y + r.y1) * U}px;width:${w}px;height:${h}px" title="${esc(title)}">${icon}</div>`;
    }
    el.blds.innerHTML = blds + renderMagnets() + '<div id="arch-ghost" hidden></div>';
    el.root.classList.toggle('picking', !!picking);
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
    for (const p of st.placed) { // drone bases: a line to every target container
      if (p.b !== db.droneBaseId || !live(p)) continue;
      const a = pxCenter(p);
      for (const id of p.targets ?? []) {
        const t = byId.get(id);
        if (!live(t)) continue;
        const b = pxCenter(t);
        svg += `<line class="drone${p.id === sel?.id ? ' on' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#arch-arrow)"/>`;
      }
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
          // items flow supplier → selected → consumer: the dashes run that way, the arrow points at the receiver
          const [p1, p2] = out ? [a, b] : [b, a];
          const marker = noRoute ? 'arch-arrow-no' : out ? 'arch-arrow-out' : 'arch-arrow-in';
          svg += `<line class="link ${out ? 'out' : 'in'}${noRoute}" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" marker-end="url(#${marker})"/>`;
          if (!near || d < near.d) near = { b, d };
        }
        if (near) {
          icons += `<div class="link-ico ${out ? 'out' : 'in'}" style="left:${(a.x + near.b.x) / 2}px;top:${(a.y + near.b.y) / 2}px"
            title="${esc(db.itemName(e.from[1]))}">${ctx.iconHtml('items', e.from[1], 24)}</div>`;
        }
      }
    }
    const marker = (id, cls) => `<marker id="${id}" class="${cls}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"/></marker>`;
    el.links.innerHTML = `<defs>${marker('arch-arrow', 'm-bridge')}${marker('arch-arrow-in', 'm-in')}${marker('arch-arrow-out', 'm-out')}${marker('arch-arrow-no', 'm-no')}</defs>${svg}`;
    return icons;
  }

  /** Magnetoids: a small arrow between the two slots they link (origin → target), clickable. */
  function renderMagnets() {
    const st = S();
    const byId = new Map(st.placed.map(p => [p.id, p]));
    let html = '';
    for (const m of st.magnets ?? []) {
      const a = byId.get(m.from); const c = byId.get(m.to);
      const isl = a && st.groups[a.g];
      if (!c || !isl || isl.q == null) continue;
      const cc = hexCenter(isl.q, isl.r);
      const s1 = magnetSlotAt(db.buildings.get(a.b), cc.x + a.x, cc.y + a.y, m.fs);
      const s2 = magnetSlotAt(db.buildings.get(c.b), cc.x + c.x, cc.y + c.y, m.ts);
      if (!s1 || !s2) continue;
      const deg = Math.atan2(-(s2.y - s1.y), s2.x - s1.x) * 180 / Math.PI;
      const title = `${tk('UI_MAGNET')}: ${db.buildingName(db.buildings.get(a.b))} → ${db.buildingName(db.buildings.get(c.b))}`;
      html += `<div class="mg${m.id === selMagnet ? ' selected' : ''}" data-mg="${esc(m.id)}" title="${esc(title)}"
        style="left:${(s1.x + s2.x) / 2 * U}px;top:${-(s1.y + s2.y) / 2 * U}px;transform:translate(-50%,-50%) rotate(${deg}deg)">➜</div>`;
    }
    return html;
  }

  /** Item a transporter carries (set on its input arm); drone bases and item antennas keep their own. */
  function armItem(p) {
    if (p.item != null) return p.item;
    return S().placed.find(q => q.id === p.twin)?.item ?? null;
  }

  /** Small panel for a building that isn't a calculator card: what it carries, a drone base's targets, magnetoids. */
  function armCardHtml(p) {
    const b = db.buildings.get(p.b);
    return `<div class="node arm-card"><div class="node-head">${ctx.iconHtml('buildings', p.b, 24)}<span class="node-title">${esc(db.buildingName(b))}</span></div>
      <div class="node-body">${logisticsHtml(p)}</div></div>`;
  }

  /** Item select, drone targets and the magnetoid button for building p (also under a calculator card). */
  function logisticsHtml(p) {
    const b = db.buildings.get(p.b);
    const st = S();
    let html = '';
    if (carries(b)) {
      const cur = armItem(p);
      const options = [`<option value="">${esc(tk('UI_CHOOSE_ITEM'))}</option>`,
        ...db.itemsByName.map(it => `<option value="${it.id}"${it.id === cur ? ' selected' : ''}>${esc(db.itemName(it.id))}</option>`)].join('');
      html += `<label class="opt">${esc(tk(isArm(b) ? 'UI_ARM_ITEM' : 'UI_CARRIED_ITEM'))}<select data-act="arm-item" data-p="${esc(p.id)}">${options}</select></label>`;
    }
    if (p.b === db.droneBaseId) {
      const rows = (p.targets ?? []).map(id => {
        const t = st.placed.find(q => q.id === id);
        if (!t) return '';
        return `<div class="logi-row">${ctx.iconHtml('buildings', t.b, 18)}<span>${esc(db.buildingName(db.buildings.get(t.b)))} · ${esc(st.groups[t.g]?.title ?? '')}</span>
          <button class="icon" data-act="drone-untarget" data-p="${esc(p.id)}" data-t="${esc(id)}" title="${esc(tk('UI_DRONE_UNTARGET'))}">×</button></div>`;
      }).join('');
      html += `<div class="logi"><div class="logi-head">${esc(tk('UI_DRONE_TARGETS'))}</div>${rows || `<div class="logi-row muted">${esc(tk('UI_DRONE_NO_TARGETS'))}</div>`}
        <button class="logi-btn${picking?.kind === 'target' ? ' on' : ''}" data-act="drone-pick" data-p="${esc(p.id)}">${esc(tk('UI_DRONE_ADD_TARGET'))}</button></div>`;
    }
    if (b?.magnetSlots && !p.fixed) {
      html += `<button class="logi-btn${picking?.kind === 'magnet' ? ' on' : ''}" data-act="magnet-pick" data-p="${esc(p.id)}"
        title="${esc(tk('UI_MAGNET_PICK_TITLE'))}">${esc(tk('UI_MAGNET_PICK'))}</button>`;
    }
    return html;
  }

  el.card.addEventListener('change', ev => {
    const t = ev.target.closest('[data-act="arm-item"]');
    if (t) ctx.ops.setArmItem(t.dataset.p, t.value === '' ? null : +t.value);
  });
  el.card.addEventListener('click', ev => {
    const t = ev.target.closest('[data-act="drone-pick"], [data-act="magnet-pick"], [data-act="drone-untarget"]');
    if (!t) return;
    if (t.dataset.act === 'drone-untarget') { ctx.ops.setDroneTarget(t.dataset.p, t.dataset.t, false); return; }
    const kind = t.dataset.act === 'drone-pick' ? 'target' : 'magnet';
    picking = picking?.kind === kind ? null : { kind, from: t.dataset.p };
    if (picking) ctx.toast(tk(kind === 'target' ? 'UI_DRONE_PICK_HINT' : 'UI_MAGNET_PICK_HINT'));
    render();
  });

  /** The selected building's card from the calculator (or its logistics panel), next to it on screen. */
  function renderCard(sel) {
    const b = sel && db.buildings.get(sel.b);
    const logi = sel && (carries(b) || b?.magnetSlots) ? logisticsHtml(sel) : '';
    const html = sel?.node != null ? ctx.cardHtml(sel.node) + (logi ? `<div class="node arm-card logi-under"><div class="node-body">${logi}</div></div>` : '')
      : logi ? armCardHtml(sel) : '';
    el.card.innerHTML = html;
    el.card.hidden = !html;
    placeCard();
  }

  // where the user dragged the card to, relative to its default spot next to the building (kept across selections)
  let cardOffset = { x: 0, y: 0 };
  try { cardOffset = { ...cardOffset, ...JSON.parse(localStorage.getItem(CARD_OFFSET_KEY)) }; } catch { /* default */ }

  function placeCard() {
    if (el.card.hidden || !selected) return;
    const pbEl = el.blds.querySelector(`.pb[data-p="${CSS.escape(selected)}"]`);
    if (!pbEl) return;
    const r = pbEl.getBoundingClientRect();
    const vp = el.card.offsetParent.getBoundingClientRect();
    const w = el.card.offsetWidth;
    const h = el.card.offsetHeight;
    let left = r.right - vp.left + CARD_GAP;
    if (left + w > vp.width - 8) left = r.left - vp.left - w - CARD_GAP;
    left += cardOffset.x;
    const top = r.top - vp.top + cardOffset.y;
    el.card.style.left = `${Math.min(Math.max(8, left), Math.max(8, vp.width - w - 8))}px`;
    el.card.style.top = `${Math.min(Math.max(8, top), Math.max(8, vp.height - h - 8))}px`;
  }

  // drag the card by its head (not by its buttons and fields)
  el.card.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || !ev.target.closest('.node-head') || ev.target.closest('button, input, select, textarea, a')) return;
    ev.preventDefault();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const start = { ...cardOffset };
    el.card.classList.add('dragging');
    const move = e => { cardOffset = { x: start.x + e.clientX - sx, y: start.y + e.clientY - sy }; placeCard(); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.card.classList.remove('dragging');
      try { localStorage.setItem(CARD_OFFSET_KEY, JSON.stringify(cardOffset)); } catch { /* not kept */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

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

  /** A building dragged in from the catalog (armed for the drag): show where it would go. */
  function hoverAt(x, y) {
    if (armed) showGhost(armed.b, armedSpot(toUnits(x, y)));
  }
  /** …and dropped at client point (x, y): place it there if it fits, then disarm. Returns whether it was placed. */
  function dropAt(x, y) {
    if (!armed) return false;
    const spot = armedSpot(toUnits(x, y));
    const isNewArm = isArm(armed.b);
    const id = spot?.ok ? (isNewArm ? ctx.ops.placeTransporter(spot.g, spot.slot) : ctx.ops.place(armed, spot.g, spot.x, spot.y)) : null;
    disarm();
    if (isNewArm && id) select(id);
    return !!spot?.ok;
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
    const mgEl = ev.target.closest('.mg');
    if (mgEl && !picking) {
      selMagnet = mgEl.dataset.mg;
      selected = null;
      render();
      return true;
    }
    const pbEl = ev.target.closest('.pb');
    if (picking) {
      const pick = picking;
      picking = null;
      const p = pbEl && S().placed.find(x => x.id === pbEl.dataset.p);
      if (p && pick.kind === 'target') {
        if (db.droneTarget(db.buildings.get(p.b)) && p.id !== pick.from) ctx.ops.setDroneTarget(pick.from, p.id, true);
        else ctx.toast(tk('UI_DRONE_BAD_TARGET'), true);
      } else if (p && pick.kind === 'magnet') {
        const err = ctx.ops.addMagnet(pick.from, p.id);
        if (err) ctx.toast(err, true);
      }
      render();
      return true;
    }
    if (pbEl) {
      const p = S().placed.find(x => x.id === pbEl.dataset.p);
      if (!p) return false;
      selMagnet = null;
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
    return false; // empty ground: the board pans; a plain click (no drag) clears the selection (clickEmpty)
  }

  /** A click on empty ground that didn't drag the map: close the card, drop the selection. */
  function clickEmpty() {
    if (!selected && !selMagnet) return;
    selMagnet = null;
    selected = null;
    picking = null;
    render();
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
    if (picking && picking.from !== id) picking = null;
    if (selected === id) return;
    selected = id;
    render();
  }

  function keyDown(ev) {
    if (ev.key === 'Escape') {
      if (picking) { picking = null; render(); } else if (armed) disarm(); else { selMagnet = null; select(null); }
      return true;
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selMagnet) {
      ev.preventDefault();
      const id = selMagnet;
      selMagnet = null;
      ctx.ops.removeMagnet(id);
      return true;
    }
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
    render, applyHighlight, pointerDown, pointerMove, pointerUp, keyDown, arm, disarm, hoverAt, dropAt, fit, fitItem, placeCard,
    armed: () => armed, select, clickEmpty,
  };
}
