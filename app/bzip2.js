// bzip2 compressor (the game reads saves with SharpZipLib's BZip2InputStream, which checks the CRCs).
// One Huffman table (written twice: the format needs at least two), cyclic BWT by prefix doubling.
// No DOM; runs under Node for testing. The decoder lives in save.js.

const BLOCK_MAX = 900000 - 19; // level 9, as bzip2's nblockMAX
const MAX_CODE_LEN = 17;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

class BitWriter {
  constructor(size) { this.buf = new Uint8Array(size); this.len = 0; this.acc = 0; this.n = 0; }
  bits(n, v) { // n <= 24
    this.acc = ((this.acc << n) | (v & ((1 << n) - 1))) >>> 0;
    this.n += n;
    while (this.n >= 8) {
      this.n -= 8;
      this.byte((this.acc >>> this.n) & 0xff);
    }
    this.acc &= (1 << this.n) - 1;
  }
  bits32(v) { this.bits(16, v >>> 16); this.bits(16, v & 0xffff); }
  byte(b) {
    if (this.len === this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.buf[this.len++] = b;
  }
  finish() { if (this.n) this.bits(8 - this.n, 0); return this.buf.subarray(0, this.len); }
}

/** Compress bytes to a bzip2 stream (block size 9). */
export function bzip2(input) {
  const w = new BitWriter(Math.max(1024, input.length >> 2));
  w.bits(8, 0x42); w.bits(8, 0x5a); w.bits(8, 0x68); w.bits(8, 0x39); // "BZh9"
  let combined = 0;
  const block = new Uint8Array(BLOCK_MAX);
  let i = 0;
  while (i < input.length) {
    // RLE1 into the block: runs of 4..255 equal bytes become 4 bytes + (run - 4)
    let n = 0;
    let crc = 0xffffffff;
    while (i < input.length) {
      const b = input[i];
      let r = 1;
      while (r < 255 && i + r < input.length && input[i + r] === b) r++;
      const size = r < 4 ? r : 5;
      if (n + size > BLOCK_MAX) break;
      for (let k = 0; k < r; k++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
      if (r < 4) for (let k = 0; k < r; k++) block[n++] = b;
      else { block[n++] = b; block[n++] = b; block[n++] = b; block[n++] = b; block[n++] = r - 4; }
      i += r;
    }
    crc = ~crc >>> 0;
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
    writeBlock(w, block.subarray(0, n), crc);
  }
  w.bits(24, 0x177245); w.bits(24, 0x385090);
  w.bits32(combined);
  return w.finish();
}

/** Sorted rotations of `s` (cyclic suffix array) by prefix doubling with counting sorts. */
function sortRotations(s) {
  const n = s.length;
  let sa = new Int32Array(n);
  let rank = new Int32Array(n);
  let tmp = new Int32Array(n);
  const cnt = new Int32Array(Math.max(256, n) + 1);
  for (let i = 0; i < n; i++) cnt[s[i] + 1]++;
  for (let c = 1; c <= 256; c++) cnt[c] += cnt[c - 1];
  for (let i = 0; i < n; i++) sa[cnt[s[i]]++] = i;
  rank[sa[0]] = 0;
  let classes = 1;
  for (let x = 1; x < n; x++) {
    if (s[sa[x]] !== s[sa[x - 1]]) classes++;
    rank[sa[x]] = classes - 1;
  }
  for (let k = 1; k < n && classes < n; k <<= 1) {
    // order by the second half (rank[i + k]) comes from sa itself; then a stable counting sort by rank[i]
    for (let x = 0; x < n; x++) { let j = sa[x] - k; if (j < 0) j += n; tmp[x] = j; }
    cnt.fill(0, 0, classes + 1);
    for (let x = 0; x < n; x++) cnt[rank[tmp[x]] + 1]++;
    for (let c = 1; c <= classes; c++) cnt[c] += cnt[c - 1];
    for (let x = 0; x < n; x++) sa[cnt[rank[tmp[x]]]++] = tmp[x];
    // new ranks
    tmp[sa[0]] = 0;
    classes = 1;
    for (let x = 1; x < n; x++) {
      const a = sa[x]; const b = sa[x - 1];
      let a2 = a + k; if (a2 >= n) a2 -= n;
      let b2 = b + k; if (b2 >= n) b2 -= n;
      if (rank[a] !== rank[b] || rank[a2] !== rank[b2]) classes++;
      tmp[a] = classes - 1;
    }
    [rank, tmp] = [tmp, rank];
  }
  return sa;
}

/** Huffman code lengths (max MAX_CODE_LEN) for symbol frequencies. */
function codeLengths(freq) {
  const m = freq.length;
  const lens = new Uint8Array(m);
  let weight = Array.from(freq, f => Math.max(1, f));
  for (;;) {
    // nodes: leaves 0..m-1, internal ones appended; pick the two lightest live nodes each time
    const wts = [...weight];
    const parent = new Int32Array(2 * m).fill(-1);
    const live = Array.from({ length: m }, (_, k) => k);
    while (live.length > 1) {
      live.sort((a, b) => wts[a] - wts[b]);
      const a = live.shift(); const b = live.shift();
      const p = wts.length;
      wts.push(wts[a] + wts[b]);
      parent[a] = p; parent[b] = p;
      live.push(p);
    }
    let maxLen = 0;
    for (let k = 0; k < m; k++) {
      let d = 0;
      for (let x = k; parent[x] >= 0; x = parent[x]) d++;
      lens[k] = Math.max(1, d);
      maxLen = Math.max(maxLen, lens[k]);
    }
    if (maxLen <= MAX_CODE_LEN) return lens;
    weight = weight.map(v => 1 + (v >> 1)); // flatten and retry, like bzip2
  }
}

function writeBlock(w, block, crc) {
  const n = block.length;
  const sa = sortRotations(block);
  let origPtr = 0;
  const inUse = new Uint8Array(256);
  for (let k = 0; k < n; k++) inUse[block[k]] = 1;
  const unseqToSeq = new Uint8Array(256);
  let nInUse = 0;
  for (let c = 0; c < 256; c++) if (inUse[c]) unseqToSeq[c] = nInUse++;
  const eob = nInUse + 1;

  // BWT last column -> MTF -> RLE2 (zero runs as RUNA/RUNB)
  const syms = new Uint16Array(n + 2);
  let ns = 0;
  const freq = new Uint32Array(nInUse + 2);
  const mtf = Uint8Array.from({ length: nInUse }, (_, k) => k);
  let zPend = 0;
  const flushZeros = () => {
    zPend--;
    for (;;) {
      const s = zPend & 1; // RUNB = 1, RUNA = 0
      syms[ns++] = s; freq[s]++;
      if (zPend < 2) break;
      zPend = (zPend - 2) >> 1;
    }
    zPend = 0;
  };
  for (let x = 0; x < n; x++) {
    let j = sa[x] - 1;
    if (j < 0) { j += n; origPtr = x; }
    const v = unseqToSeq[block[j]];
    let p = 0;
    while (mtf[p] !== v) p++;
    for (let q = p; q > 0; q--) mtf[q] = mtf[q - 1];
    mtf[0] = v;
    if (p === 0) { zPend++; continue; }
    if (zPend) flushZeros();
    syms[ns++] = p + 1; freq[p + 1]++;
  }
  if (zPend) flushZeros();
  syms[ns++] = eob; freq[eob]++;

  const lens = codeLengths(freq);
  const codes = new Uint32Array(lens.length);
  for (let len = 1, code = 0; len <= MAX_CODE_LEN; len++, code <<= 1) {
    for (let s = 0; s < lens.length; s++) if (lens[s] === len) codes[s] = code++;
  }

  w.bits(24, 0x314159); w.bits(24, 0x265359);
  w.bits32(crc);
  w.bits(1, 0); // not randomised
  w.bits(24, origPtr);
  let used16 = 0;
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) if (inUse[i * 16 + j]) used16 |= 0x8000 >> i;
  w.bits(16, used16);
  for (let i = 0; i < 16; i++) {
    if (!(used16 & (0x8000 >> i))) continue;
    let row = 0;
    for (let j = 0; j < 16; j++) if (inUse[i * 16 + j]) row |= 0x8000 >> j;
    w.bits(16, row);
  }
  const nGroups = 2;
  const nSelectors = Math.ceil(ns / 50);
  w.bits(3, nGroups);
  w.bits(15, nSelectors);
  for (let k = 0; k < nSelectors; k++) w.bits(1, 0); // always table 0 (MTF index 0)
  for (let g = 0; g < nGroups; g++) {
    let cur = lens[0];
    w.bits(5, cur);
    for (let s = 0; s < lens.length; s++) {
      while (cur < lens[s]) { w.bits(2, 2); cur++; }
      while (cur > lens[s]) { w.bits(2, 3); cur--; }
      w.bits(1, 0);
    }
  }
  for (let k = 0; k < ns; k++) w.bits(lens[syms[k]], codes[syms[k]]);
}
