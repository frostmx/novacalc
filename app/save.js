// Nova Lands save files (Worlds/<version>/WORLDnnn.dat): base64 -> bzip2 -> binary tree.
// Same format as tools/save_reader.py; no DOM dependencies so it also runs under Node for testing.

/** Decode a save file's raw bytes (or base64 text) into a plain object tree. */
export function decodeSave(input) {
  const text = typeof input === 'string' ? input : new TextDecoder('ascii').decode(input);
  const bin = atob(text.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return parseTree(bunzip2(bytes));
}

// ---------- binary tree ----------
// Tag byte, then: 1 list (int32 n, values) | 2 dict (int32 n, (key, value)…) | 3 string | 4 int32 | 5 int64
// | 6 bool | 7 float32 | 8 float64. Strings are 7-bit length-prefixed UTF-8 (.NET BinaryWriter).
function parseTree(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder('utf-8');
  let p = 0;
  const u7 = () => {
    let r = 0;
    for (let s = 0; ; s += 7) {
      const c = bytes[p++];
      r |= (c & 0x7f) << s;
      if (!(c & 0x80)) return r;
    }
  };
  const str = () => {
    const n = u7();
    const s = utf8.decode(bytes.subarray(p, p + n));
    p += n;
    return s;
  };
  const val = () => {
    const tag = bytes[p++];
    switch (tag) {
      case 1: { const n = view.getInt32(p, true); p += 4; const a = new Array(n); for (let i = 0; i < n; i++) a[i] = val(); return a; }
      case 2: { const n = view.getInt32(p, true); p += 4; const o = {}; for (let i = 0; i < n; i++) { const k = str(); o[k] = val(); } return o; }
      case 3: return str();
      case 4: { const v = view.getInt32(p, true); p += 4; return v; }
      case 5: { const v = Number(view.getBigInt64(p, true)); p += 8; return v; }
      case 6: return bytes[p++] !== 0;
      case 7: { const v = view.getFloat32(p, true); p += 4; return v; }
      case 8: { const v = view.getFloat64(p, true); p += 8; return v; }
      default: throw new Error(`save: unknown tag ${tag} at ${p - 1}`);
    }
  };
  return val();
}

// ---------- bzip2 ----------
// Minimal decoder (no CRC check): Huffman + MTF/RLE2 + inverse BWT + RLE1, per the bzip2 format.
export function bunzip2(src) {
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  const bits = n => {
    while (bitCount < n) {
      if (pos >= src.length) throw new Error('bzip2: unexpected end of data');
      bitBuf = ((bitBuf << 8) | src[pos++]) >>> 0;
      bitCount += 8;
    }
    bitCount -= n;
    return (bitBuf >>> bitCount) & ((1 << n) - 1);
  };
  const bit = () => bits(1);

  if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) throw new Error('bzip2: bad signature');
  const level = bits(8) - 0x30;
  if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
  const blockMax = level * 100000;
  const tt = new Uint32Array(blockMax);

  let out = new Uint8Array(Math.max(1024, src.length * 8));
  let outLen = 0;
  const put = b => {
    if (outLen === out.length) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; }
    out[outLen++] = b;
  };

  for (;;) {
    const m1 = bits(24);
    const m2 = bits(24);
    if (m1 === 0x177245 && m2 === 0x385090) break; // end of stream
    if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block magic');
    bits(16); bits(16); // block CRC
    if (bit()) throw new Error('bzip2: randomized blocks are not supported');
    const origPtr = bits(24);

    // symbol map
    const seqToUnseq = [];
    const used = bits(16);
    for (let i = 0; i < 16; i++) {
      if (!(used & (0x8000 >> i))) continue;
      const row = bits(16);
      for (let j = 0; j < 16; j++) if (row & (0x8000 >> j)) seqToUnseq.push(i * 16 + j);
    }
    const alphaSize = seqToUnseq.length + 2;
    const eob = alphaSize - 1;

    // selectors (MTF-coded group indices)
    const nGroups = bits(3);
    const nSelectors = bits(15);
    const groupMtf = Array.from({ length: nGroups }, (_, i) => i);
    const selectors = new Uint8Array(nSelectors);
    for (let i = 0; i < nSelectors; i++) {
      let j = 0;
      while (bit()) j++;
      const v = groupMtf[j];
      groupMtf.splice(j, 1);
      groupMtf.unshift(v);
      selectors[i] = v;
    }

    // canonical Huffman tables, one per group
    const tables = [];
    for (let g = 0; g < nGroups; g++) {
      const lens = new Uint8Array(alphaSize);
      let cur = bits(5);
      for (let s = 0; s < alphaSize; s++) {
        while (bit()) cur += bit() ? -1 : 1;
        lens[s] = cur;
      }
      const maxLen = Math.max(...lens);
      const count = new Uint32Array(maxLen + 2);
      for (const l of lens) count[l]++;
      const sorted = [];
      for (let l = 1; l <= maxLen; l++) for (let s = 0; s < alphaSize; s++) if (lens[s] === l) sorted.push(s);
      const firstCode = new Int32Array(maxLen + 2);
      const firstIndex = new Int32Array(maxLen + 2);
      for (let l = 1, code = 0, idx = 0; l <= maxLen; l++) {
        firstCode[l] = code;
        firstIndex[l] = idx;
        idx += count[l];
        code = (code + count[l]) << 1;
      }
      tables.push({ maxLen, count, sorted, firstCode, firstIndex });
    }
    const decodeSym = t => {
      let v = 0;
      for (let l = 1; l <= t.maxLen; l++) {
        v = (v << 1) | bit();
        const k = v - t.firstCode[l];
        if (k >= 0 && k < t.count[l]) return t.sorted[t.firstIndex[l] + k];
      }
      throw new Error('bzip2: bad Huffman code');
    };

    // MTF + RLE2 -> block bytes (low 8 bits of tt)
    const mtf = Array.from({ length: seqToUnseq.length }, (_, i) => i);
    const byteCount = new Uint32Array(256);
    let n = 0;
    let runPos = 0;
    let runLen = 0;
    let group = -1;
    let left = 0;
    let table = null;
    for (;;) {
      if (left === 0) {
        group++;
        if (group >= nSelectors) throw new Error('bzip2: ran out of selectors');
        table = tables[selectors[group]];
        left = 50;
      }
      left--;
      const sym = decodeSym(table);
      if (sym <= 1) { // RUNA / RUNB
        if (runPos === 0) { runPos = 1; runLen = 0; }
        runLen += runPos << sym;
        runPos <<= 1;
        continue;
      }
      if (runPos) {
        runPos = 0;
        const b = seqToUnseq[mtf[0]];
        if (n + runLen > blockMax) throw new Error('bzip2: block overflow');
        byteCount[b] += runLen;
        while (runLen--) tt[n++] = b;
      }
      if (sym === eob) break;
      const idx = sym - 1;
      const v = mtf[idx];
      mtf.splice(idx, 1);
      mtf.unshift(v);
      const b = seqToUnseq[v];
      if (n >= blockMax) throw new Error('bzip2: block overflow');
      byteCount[b]++;
      tt[n++] = b;
    }
    if (origPtr >= n) throw new Error('bzip2: bad origPtr');

    // inverse BWT: high bits of tt[] link each position to the next
    for (let i = 0, sum = 0; i < 256; i++) { const c = byteCount[i]; byteCount[i] = sum; sum += c; }
    for (let i = 0; i < n; i++) { const b = tt[i] & 0xff; tt[byteCount[b]++] |= i << 8; }

    // walk the chain, undoing RLE1 (4 equal bytes are followed by a repeat count)
    let tPos = tt[origPtr] >>> 8;
    let last = -1;
    let same = 0;
    for (let k = 0; k < n; k++) {
      tPos = tt[tPos];
      const b = tPos & 0xff;
      tPos >>>= 8;
      if (same === 4) {
        for (let r = 0; r < b; r++) put(last);
        same = 0;
        last = -1;
        continue;
      }
      put(b);
      if (b === last) same++;
      else { last = b; same = 1; }
    }
  }
  return out.subarray(0, outLen);
}

// ---------- what the calculator takes from a save ----------

/**
 * Learned skills and Gem Overclocker gems. `gemBuildingId` is the overclocker's building id from gamedata.
 * Skill State: 2 = learned (1 = available, 0 = locked). Overclocker inventory slot i holds the gem for group i.
 */
export function readProfile(save, gemBuildingId) {
  const skills = (save.PlayerSkills ?? []).filter(s => s.State === 2).map(s => s.Id);
  let gems = null;
  for (const layer of Object.values(save.World?.World ?? {})) {
    for (const area of layer) {
      for (const b of area.Buildings ?? []) {
        if (b.BuildingId === gemBuildingId) gems = (b.Inventory ?? []).map(s => (s.Resource >= 0 && s.Amount > 0 ? s.Resource : null));
      }
    }
  }
  return { skills, gems, name: save.Name, day: save.Time?.CurrentDay, savedAt: save.RealTime };
}

/**
 * Buildings the calculator may understand, with the island they stand on:
 *  - with a recipe selected: { buildingId, recipeId, lubricant, creatures, island }
 *    (`lubricant` — the type it is set to take, `creatures` — Animal Barn's creature count);
 *  - farm plots (not the Advanced Farm's inner plots): { buildingId, seed, fertilizer, watered, island };
 *  - generators (anything that burns fuel or makes energy): { buildingId, generator: true, island }.
 * Every record also has `uid` (the building's save id) and its world position `x`, `y`.
 * `island` is { id, biome, x, y (centre) }. The caller decides which ones it can place.
 */
export function readFactory(save) {
  const out = [];
  for (const layer of Object.values(save.World?.World ?? {})) {
    for (const area of layer) {
      const island = { id: area.Id, biome: area.Biome ?? '', x: area.X ?? 0, y: area.Y ?? 0 };
      for (const b of area.Buildings ?? []) {
        const at = { uid: b.Id, x: b.X ?? 0, y: b.Y ?? 0 }; // world position
        if (typeof b.RecipeId === 'number' && b.RecipeId >= 0) {
          out.push({
            ...at,
            buildingId: b.BuildingId,
            recipeId: b.RecipeId,
            lubricant: b.CurrentRequiredLubricant > 0 ? b.CurrentRequiredLubricant : null,
            fertilizer: b.CurrentRequiredFertilizer > 0 ? b.CurrentRequiredFertilizer : null,
            creatures: typeof b.CreatureCount === 'number' ? b.CreatureCount : null,
            island,
          });
        } else if ('ConsumingFuel' in b) {
          out.push({ ...at, buildingId: b.BuildingId, generator: true, island });
        } else if ('Seed' in b && b.IsInnerFarmPlot !== 'True') {
          const seed = b.CurrentRequiredCrop >= 0 ? b.CurrentRequiredCrop : b.Seed;
          out.push({
            ...at,
            buildingId: b.BuildingId,
            seed: seed >= 0 ? seed : null,
            fertilizer: b.CurrentRequiredFertilizer > 0 ? b.CurrentRequiredFertilizer : null,
            watered: (b.Water?.CurrentCount ?? 0) > 0,
            island,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Every island, every placed building and every prop (world positions), for the architect view.
 * Islands: { id, biome, x, y (centre), locked, premade, outOfMap }; buildings: { uid, buildingId, x, y, islandId,
 * twin?, item? }; props: { uid, propId, x, y, islandId } (rocks, bushes, trees, …; planted crops are left out —
 * they belong to their farm plot). The Advanced Farm's inner plots are part of their farm and are left out too.
 */
export function readLayout(save) {
  const islands = [];
  const buildings = [];
  const props = [];
  for (const layer of Object.values(save.World?.World ?? {})) {
    for (const area of layer) {
      islands.push({
        id: area.Id, biome: area.Biome ?? '', x: area.X ?? 0, y: area.Y ?? 0,
        locked: area.Locked === 'True', premade: area.Premade === 'True', outOfMap: area.OutOfMap === 'True',
      });
      for (const p of area.Props ?? []) {
        if (!p.HasOwnerFarmPlot) props.push({ uid: p.Id, propId: p.BuildingId, x: p.X ?? 0, y: p.Y ?? 0, islandId: area.Id });
      }
      for (const b of area.Buildings ?? []) {
        if (b.IsInnerFarmPlot === 'True') continue;
        buildings.push({
          uid: b.Id, buildingId: b.BuildingId, x: b.X ?? 0, y: b.Y ?? 0, islandId: area.Id,
          ...(b.TwinContainer?.Id != null ? { twin: b.TwinContainer.Id } : {}), // transporter arm's other end
          ...(b.RequiredResource >= 0 ? { item: b.RequiredResource } : {}), // what an input arm carries
        });
      }
    }
  }
  return { islands, buildings, props };
}
