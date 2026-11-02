// EGSC bitstream container parser — bit-exact mirror of
// spatial-vivid-egsc Encoder/python/src/xencode/processor/stream.py.
//
// Container layout (all multi-byte scalars big-endian, bit order MSB-first):
//   [u32 metaLen][unit0: 4B header (unitType 4b + reserved 28b) + gsbs_meta]
//   [u32 subLen ][unit1: 4B header + concatenated substream payloads]

const ATTR_NAMES = {
  0: "means", 1: "opacity", 2: "scaling", 3: "rotation",
  4: "features_dc", 20: "features_rest", 21: "importance",
  100: "time", 101: "log_duration", 102: "velocity",
};

const _f32buf = new ArrayBuffer(4);
const _f32dv = new DataView(_f32buf);
const _f32arr = new Float32Array(_f32buf);

export class BitReader {
  constructor(bytes, offset = 0) {
    this.d = bytes;
    this.i = offset;
    this.p = 0; // bit position within current byte
  }
  bits(n) {
    let r = 0;
    while (n > 0) {
      if (this.i >= this.d.length) throw new Error("bitstream overrun");
      const avail = 8 - this.p;
      const take = n < avail ? n : avail;
      const mask = (1 << avail) - 1;
      const v = (this.d[this.i] & mask) >>> (avail - take);
      r = (r << take) | v;
      this.p += take;
      n -= take;
      if (this.p === 8) { this.i++; this.p = 0; }
    }
    return r;
  }
  align() {
    if (this.p > 0) { this.i++; this.p = 0; }
  }
  u8() { return this.bits(8); }
  u16() { return this.bits(16); }
  u32() { return this.bits(32); }
  f32() {
    _f32dv.setUint32(0, this.bits(32));
    return _f32dv.getFloat32(0);
  }
  f32s(count) {
    const out = new Array(count);
    for (let k = 0; k < count; k++) out[k] = this.f32();
    return out;
  }
  bytes(n) {
    if (this.p === 0) {
      const out = this.d.subarray(this.i, this.i + n);
      if (out.length !== n) throw new Error("bitstream overrun");
      this.i += n;
      return out;
    }
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = this.bits(8);
    return out;
  }
  get offset() { return this.i; }
}

/** Parse an .egsc file into a decode plan. */
export function parseEGSC(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16) throw new Error("Not an EGSC stream (too short).");

  const metaLen = dv.getUint32(0);
  const r = new BitReader(bytes, 4);
  if (r.bits(4) !== 0) throw new Error("Expected metadata unit (unit_type 0).");
  r.bits(28); // reserved

  // ---- gsbs_meta ----
  const profileIdc = r.bits(8);
  const gsPointsNum = r.bits(32);
  const nStreams = r.bits(5);
  const shDegree = r.bits(3);
  for (let i = 0; i < 3; i++) { r.f32(); r.f32(); } // position min/max
  const nSubsets = r.bits(8);
  const subsetPoints = [];
  for (let i = 0; i < nSubsets; i++) subsetPoints.push(r.bits(32));

  const streams = [];
  for (let i = 0; i < nStreams; i++) {
    const size = r.bits(32);
    const subsetId = r.bits(8);
    const type = r.bits(8); // 0 entropy, 1 texture(astc), 2 video
    let meta;
    if (type === 0) {
      meta = {
        kind: "entropy",
        entropy: r.bits(8),      // 1 = zstd
        attr: r.bits(8),
        bitdepth: r.bits(8),
        byteshift: r.bits(8),    // stored as max(0, packing byteshift)
      };
    } else if (type === 1) {
      const entropy = r.bits(8);
      const codecId = r.bits(8); // 1 = astc
      const width = r.bits(16), height = r.bits(16);
      const regionW = r.bits(16), regionH = r.bits(16);
      const scan = r.bits(4);
      const blockSize = scan === 1 ? r.bits(8) : 0;
      const regionCount = r.bits(8) + 1;
      const regions = [];
      for (let k = 0; k < regionCount; k++) regions.push([r.bits(16), r.bits(16)]);
      const chanNum = r.bits(8);
      const byteshift = r.bits(8);
      r.align();
      const attr = r.bits(8);
      meta = { kind: "texture", entropy, codecId, width, height, regionW, regionH,
               scan, blockSize, regions, chanNum, byteshift, attr };
    } else {
      throw new Error("Video substreams are not supported by this decoder.");
    }
    streams.push({ index: i, size, subsetId, type, meta, attr: meta.attr });
  }

  const subsets = [];
  for (let s = 0; s < nSubsets; s++) {
    const count = r.bits(8);
    const reconstruction = {};
    for (let k = 0; k < count; k++) {
      const attrId = r.bits(8);
      const component = r.bits(8);
      const quantType = r.bits(4); // 2 minmax, 3 patch/group
      const bits = r.bits(8);
      const predType = r.bits(4);
      let prediction = null;
      if (predType === 1) prediction = { byteshift: r.bits(4), blockSize: r.bits(16) };
      r.bits(4); // transformation type (0 = None; decode side is identity)
      let quant;
      if (quantType === 2) {
        // interleaved (min[i], max[i]) pairs — mirrors reconstruction_information.read
        const mn = new Array(component), mx = new Array(component);
        for (let c = 0; c < component; c++) { mn[c] = r.f32(); mx[c] = r.f32(); }
        quant = { kind: "minmax", min: mn, max: mx };
      } else if (quantType === 3) {
        const patchNum = r.bits(32);
        const patches = [];
        for (let p = 0; p < patchNum; p++) {
          const size = r.bits(32);
          patches.push({ size, min: r.f32s(component), max: r.f32s(component) });
        }
        quant = { kind: "patch", patches };
      } else {
        throw new Error("Unsupported quantization type " + quantType);
      }
      r.align();
      reconstruction[ATTR_NAMES[attrId] ?? ("attr" + attrId)] = {
        attrId, component, bits, prediction, quant,
      };
    }
    subsets.push({ id: s, numPoints: subsetPoints[s], reconstruction });
  }
  r.align();
  // Python's reader indexes into stream[4:], so metaLen counts from there;
  // this reader is absolute (started at offset 4 after the metaLen field).
  if (r.offset !== 4 + metaLen)
    throw new Error(`Metadata length mismatch: consumed ${r.offset}, header says ${4 + metaLen}.`);

  // ---- sub bitstreams unit ----
  const subLen = dv.getUint32(4 + metaLen);
  const r2 = new BitReader(bytes, 8 + metaLen);
  if (r2.bits(4) !== 1) throw new Error("Expected substream unit (unit_type 1).");
  r2.bits(28);
  for (const s of streams) s.data = r2.bytes(s.size);
  if (r2.offset !== 8 + metaLen + subLen)
    throw new Error(`Substream length mismatch: consumed ${r2.offset}, header says ${8 + metaLen + subLen}.`);

  for (const s of streams) s.attrName = ATTR_NAMES[s.attr] ?? ("attr" + s.attr);
  return { shDegree, gsPointsNum, nSubsets, subsets, streams };
}

/** Parse the 16-byte .astc file header (astcenc output). */
export function parseAstcHeader(data) {
  if (data.length < 16) throw new Error("ASTC data too short.");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== 0x5ca1ab13) throw new Error("Bad ASTC magic.");
  const blockX = data[4], blockY = data[5], blockZ = data[6];
  const w = data[7] | (data[8] << 8) | (data[9] << 16);
  const h = data[10] | (data[11] << 8) | (data[12] << 16);
  return { blockX, blockY, blockZ, width: w, height: h, data: data.subarray(16) };
}
