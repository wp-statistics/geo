// Streaming MaxMind DB reader for Cloudflare Workers.
//
// The .mmdb files (61 MB MaxMind, 125 MB DB-IP) are far too large to load into a
// Worker's 128 MB memory. Instead we keep them in R2 and read only the handful of
// small byte-ranges each lookup actually needs (~40 KB per lookup, proven to give
// byte-for-byte identical answers to the stock `maxmind` library).
//
// The decoding logic below is a faithful async port of `mmdb-lib` (the library the
// old Vercel code used); the only real change is that every read goes through an
// R2-backed block cache instead of a fully-resident Buffer.

const DATA_SECTION_SEPARATOR_SIZE = 16;
const POINTER_VALUE_OFFSET = [0, 2048, 526336, 0];
const METADATA_START_MARKER = Uint8Array.from([
  0xab, 0xcd, 0xef, 0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f, 0x6d,
]); // "\xab\xcd\xefMaxMind.com"
const TEXT = new TextDecoder('utf-8');
const BLOCK_SIZE = 8192;      // range-read granularity
const MAX_CACHED_BLOCKS = 6000; // ~48 MB ceiling on a warm isolate's block cache

// ---------------------------------------------------------------------------
// Byte sources: expose byteAt(offset) / slice(offset, len) plus numeric readers.
// `ensure()` guarantees the bytes are resident before any synchronous read.
// ---------------------------------------------------------------------------

class BaseSource {
  u16(o) { return (this.byteAt(o) << 8) | this.byteAt(o + 1); }
  u32(o) {
    return this.byteAt(o) * 0x1000000 +
      ((this.byteAt(o + 1) << 16) | (this.byteAt(o + 2) << 8) | this.byteAt(o + 3));
  }
  uintBE(o, len) {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + this.byteAt(o + i);
    return v;
  }
  int32BE(o) { return this.u32(o) | 0; }
  doubleBE(o) { const b = this.slice(o, 8); return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(0, false); }
  floatBE(o) { const b = this.slice(o, 4); return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(0, false); }
  str(o, len) { return TEXT.decode(this.slice(o, len)); }
}

// A fully-resident buffer (used for the small metadata block at the file's tail).
class MemSource extends BaseSource {
  constructor(bytes) { super(); this.bytes = bytes; }
  async ensure() { /* already resident */ }
  byteAt(o) { return this.bytes[o]; }
  slice(o, len) { return this.bytes.slice(o, o + len); }
  get length() { return this.bytes.length; }
}

// Backed by an R2 object, reading fixed-size blocks on demand and caching them
// in the isolate so warm lookups touch the network rarely (or never).
class R2Source extends BaseSource {
  constructor(bucket, key, fileSize) {
    super();
    this.bucket = bucket;
    this.key = key;
    this.fileSize = fileSize;
    this.blocks = new Map(); // blockIndex -> Uint8Array
  }

  async ensure(offset, length) {
    if (length <= 0) return;
    const first = Math.floor(offset / BLOCK_SIZE);
    const last = Math.floor((offset + length - 1) / BLOCK_SIZE);
    // Coalesce contiguous missing blocks into a single range request.
    let runStart = -1;
    for (let b = first; b <= last + 1; b++) {
      const missing = b <= last && !this.blocks.has(b);
      if (missing && runStart === -1) runStart = b;
      else if (!missing && runStart !== -1) { await this.fetchBlocks(runStart, b - 1); runStart = -1; }
    }
  }

  async fetchBlocks(from, to) {
    const start = from * BLOCK_SIZE;
    const end = Math.min((to + 1) * BLOCK_SIZE, this.fileSize);
    const obj = await this.bucket.get(this.key, { range: { offset: start, length: end - start } });
    if (!obj) throw new Error(`R2 object ${this.key} missing or range unsatisfiable`);
    const buf = new Uint8Array(await obj.arrayBuffer());
    for (let b = from; b <= to; b++) {
      const s = b * BLOCK_SIZE - start;
      this.blocks.set(b, buf.subarray(s, Math.min(s + BLOCK_SIZE, buf.length)));
    }
    // Keep the isolate's memory bounded; oldest blocks are evicted first.
    if (this.blocks.size > MAX_CACHED_BLOCKS) {
      const drop = this.blocks.size - MAX_CACHED_BLOCKS;
      let i = 0;
      for (const k of this.blocks.keys()) { if (i++ >= drop) break; this.blocks.delete(k); }
    }
  }

  byteAt(offset) {
    const b = Math.floor(offset / BLOCK_SIZE);
    return this.blocks.get(b)[offset - b * BLOCK_SIZE];
  }

  slice(offset, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.byteAt(offset + i);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Decoder — async port of mmdb-lib/lib/decoder.js
// ---------------------------------------------------------------------------

class Decoder {
  constructor(source, baseOffset) {
    this.src = source;
    this.baseOffset = baseOffset;
  }

  async decode(offset) {
    await this.src.ensure(offset, 1);
    const ctrlByte = this.src.byteAt(offset++);
    let type = ctrlByte >> 5;

    if (type === 1) { // Pointer
      const ptr = await this.decodePointer(ctrlByte, offset);
      const target = await this.decode(ptr.value);
      return { value: target.value, offset: ptr.offset };
    }
    if (type === 0) { // Extended type: real type is in the next byte
      await this.src.ensure(offset, 1);
      type = this.src.byteAt(offset) + 7;
      offset++;
    }
    const size = await this.sizeFromCtrlByte(ctrlByte, offset);
    return this.decodeByType(type, size.offset, size.value);
  }

  async sizeFromCtrlByte(ctrlByte, offset) {
    const size = ctrlByte & 0x1f;
    if (size < 29) return { value: size, offset };
    await this.src.ensure(offset, 3);
    if (size === 29) return { value: 29 + this.src.byteAt(offset), offset: offset + 1 };
    if (size === 30) return { value: 285 + this.src.u16(offset), offset: offset + 2 };
    return { value: 65821 + this.src.uintBE(offset, 3), offset: offset + 3 };
  }

  async decodePointer(ctrlByte, offset) {
    const pointerSize = (ctrlByte >> 3) & 3;
    await this.src.ensure(offset, pointerSize + 1);
    const base = this.baseOffset + POINTER_VALUE_OFFSET[pointerSize];
    let packed;
    if (pointerSize === 0) packed = ((ctrlByte & 7) << 8) | this.src.byteAt(offset);
    else if (pointerSize === 1) packed = ((ctrlByte & 7) << 16) | this.src.u16(offset);
    else if (pointerSize === 2) packed = ((ctrlByte & 7) << 24) | this.src.uintBE(offset, 3);
    else packed = this.src.u32(offset);
    return { value: base + packed, offset: offset + pointerSize + 1 };
  }

  async decodeByType(type, offset, size) {
    const newOffset = offset + size;
    switch (type) {
      case 2: await this.src.ensure(offset, size); return { value: this.src.str(offset, size), offset: newOffset };      // Utf8String
      case 7: return this.decodeMap(size, offset);                                                                       // Map
      case 6: await this.src.ensure(offset, size); return { value: this.src.uintBE(offset, size), offset: newOffset };   // Uint32
      case 3: await this.src.ensure(offset, 8); return { value: this.src.doubleBE(offset), offset: newOffset };          // Double
      case 11: return this.decodeArray(size, offset);                                                                    // Array
      case 14: return { value: size !== 0, offset };                                                                     // Boolean
      case 15: await this.src.ensure(offset, 4); return { value: this.src.floatBE(offset), offset: newOffset };          // Float
      case 4: await this.src.ensure(offset, size); return { value: this.src.slice(offset, size), offset: newOffset };    // Bytes
      case 5: await this.src.ensure(offset, size); return { value: this.src.uintBE(offset, size), offset: newOffset };   // Uint16
      case 8: await this.src.ensure(offset, size); return { value: this.decodeInt32(offset, size), offset: newOffset };  // Int32
      case 9: await this.src.ensure(offset, size); return { value: this.decodeUint(offset, size), offset: newOffset };   // Uint64
      case 10: await this.src.ensure(offset, size); return { value: this.decodeUint(offset, size), offset: newOffset };  // Uint128
    }
    throw new Error('Unknown mmdb type ' + type + ' at offset ' + offset);
  }

  async decodeMap(size, offset) {
    const map = {};
    for (let i = 0; i < size; i++) {
      const key = await this.decode(offset);
      const val = await this.decode(key.offset);
      offset = val.offset;
      map[key.value] = val.value;
    }
    return { value: map, offset };
  }

  async decodeArray(size, offset) {
    const arr = new Array(size);
    for (let i = 0; i < size; i++) {
      const el = await this.decode(offset);
      offset = el.offset;
      arr[i] = el.value;
    }
    return { value: arr, offset };
  }

  decodeInt32(offset, size) {
    if (size === 0) return 0;
    if (size < 4) return this.src.uintBE(offset, size);
    return this.src.int32BE(offset);
  }

  decodeUint(offset, size) {
    if (size === 0) return 0;
    if (size <= 6) return this.src.uintBE(offset, size);
    if (size > 16) return 0;
    let n = 0n;
    for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(this.src.byteAt(offset + i));
    return n.toString();
  }
}

// ---------------------------------------------------------------------------
// Metadata (lives at the tail of the file, fully resident when we parse it)
// ---------------------------------------------------------------------------

function findMetadataStart(bytes) {
  const mlen = METADATA_START_MARKER.length;
  for (let i = bytes.length - mlen; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < mlen; j++) {
      if (bytes[i + j] !== METADATA_START_MARKER[j]) { match = false; break; }
    }
    if (match) return i + mlen;
  }
  throw new Error('mmdb metadata marker not found in tail');
}

async function parseMetadata(tailBytes) {
  const start = findMetadataStart(tailBytes);
  const src = new MemSource(tailBytes);
  const decoder = new Decoder(src, start);
  const m = (await decoder.decode(start)).value;
  if (![24, 28, 32].includes(m.record_size)) throw new Error('Unsupported record size ' + m.record_size);
  return {
    nodeCount: m.node_count,
    recordSize: m.record_size,
    nodeByteSize: m.record_size / 4,
    searchTreeSize: (m.node_count * m.record_size) / 4,
    ipVersion: m.ip_version,
    databaseType: m.database_type,
    buildEpoch: m.build_epoch,
  };
}

// ---------------------------------------------------------------------------
// IP parsing (port of mmdb-lib/lib/ip.js) — returns raw bytes (4 or 16)
// ---------------------------------------------------------------------------

function parseIP(ip) {
  return ip.indexOf(':') === -1 ? parseIPv4(ip) : parseIPv6(ip);
}

function parseIPv4(input) {
  const p = input.split('.', 4);
  return Uint8Array.from([parseInt(p[0], 10), parseInt(p[1], 10), parseInt(p[2], 10), parseInt(p[3], 10)]);
}

function hex(v) { const h = parseInt(v, 10).toString(16); return h.length === 2 ? h : '0' + h; }

function parseIPv6(input) {
  const addr = new Uint8Array(16);
  // Embedded IPv4, e.g. ::ffff:64.17.254.216
  const ip = input.indexOf('.') > -1
    ? input.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, (_m, a, b, c, d) => hex(a) + hex(b) + ':' + hex(c) + hex(d))
    : input;
  const [left, right] = ip.split('::', 2);
  if (left) {
    const parts = left.split(':');
    for (let i = 0; i < parts.length; i++) {
      const chunk = parseInt(parts[i], 16);
      addr[i * 2] = chunk >> 8;
      addr[i * 2 + 1] = chunk & 0xff;
    }
  }
  if (right) {
    const parts = right.split(':');
    const offset = 16 - parts.length * 2;
    for (let i = 0; i < parts.length; i++) {
      const chunk = parseInt(parts[i], 16);
      addr[offset + i * 2] = chunk >> 8;
      addr[offset + i * 2 + 1] = chunk & 0xff;
    }
  }
  return addr;
}

function bitAt(raw, idx) { return (raw[idx >> 3] >>> (7 ^ (idx & 7))) & 1; }

// ---------------------------------------------------------------------------
// Reader — tree walk + data decode
// ---------------------------------------------------------------------------

class Reader {
  constructor(source, meta) {
    this.src = source;
    this.meta = meta;
    this.ipv4Start = 0;
  }

  async computeIpv4Start() {
    // In an IPv6 tree, IPv4 addresses live under the node reached by 96 zero bits.
    if (this.meta.ipVersion === 4) { this.ipv4Start = 0; return; }
    let node = 0;
    for (let i = 0; i < 96 && node < this.meta.nodeCount; i++) {
      const offset = node * this.meta.nodeByteSize;
      await this.src.ensure(offset, this.meta.nodeByteSize);
      node = this.left(offset);
    }
    this.ipv4Start = node;
  }

  left(offset) {
    const s = this.src;
    switch (this.meta.recordSize) {
      case 24: return s.uintBE(offset, 3);
      case 28: return ((s.byteAt(offset + 3) & 0xf0) << 20) | s.uintBE(offset, 3);
      case 32: return s.u32(offset);
    }
  }

  right(offset) {
    const s = this.src;
    switch (this.meta.recordSize) {
      case 24: return s.uintBE(offset + 3, 3);
      case 28: return ((s.byteAt(offset + 3) & 0x0f) << 24) | s.uintBE(offset + 4, 3);
      case 32: return s.u32(offset + 4);
    }
  }

  async findAddressInTree(raw) {
    const nodeCount = this.meta.nodeCount;
    const bitLength = raw.length * 8;
    let node = raw.length === 4 ? this.ipv4Start : 0;
    for (let depth = 0; depth < bitLength && node < nodeCount; depth++) {
      const offset = node * this.meta.nodeByteSize;
      await this.src.ensure(offset, this.meta.nodeByteSize);
      node = bitAt(raw, depth) ? this.right(offset) : this.left(offset);
    }
    return node > nodeCount ? node : null;
  }

  async get(ip) {
    const raw = parseIP(ip);
    if (!raw || (raw.length !== 4 && raw.length !== 16)) return null;
    const pointer = await this.findAddressInTree(raw);
    if (pointer === null) return null;
    const resolved = pointer - this.meta.nodeCount + this.meta.searchTreeSize;
    const decoder = new Decoder(this.src, this.meta.searchTreeSize + DATA_SECTION_SEPARATOR_SIZE);
    return (await decoder.decode(resolved)).value;
  }
}

// Open a reader over an R2 object. `bucket` is the R2 binding, `key` the object name.
export async function openReader(bucket, key) {
  const head = await bucket.head(key);
  if (!head) throw new Error(`R2 object not found: ${key}`);
  const size = head.size;
  const src = new R2Source(bucket, key, size);

  const tailLen = Math.min(256 * 1024, size);
  const tailObj = await bucket.get(key, { range: { offset: size - tailLen, length: tailLen } });
  const tail = new Uint8Array(await tailObj.arrayBuffer());
  const meta = await parseMetadata(tail);

  const reader = new Reader(src, meta);
  await reader.computeIpv4Start();
  return reader;
}

export { parseIP };
