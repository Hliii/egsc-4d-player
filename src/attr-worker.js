// Attribute worker: zstd + lsb/msb merge + DPCM + dequant for one attribute.
// Receives the entropy substreams and reconstruction info; returns the
// dequantized Float32Array (and the float64 opacity trace when applicable).
import { decompress as zstdDecompress } from "./vendor/fzstd.mjs";

const F = Math.fround;
const rec_quant_patches = (recon) => recon.quant.patches;
const isNode = typeof process !== "undefined" && process.versions?.node;
let nodePort = null;
if (isNode) ({ parentPort: nodePort } = await import("node:worker_threads"));

const post = (m, t) =>
  nodePort ? nodePort.postMessage(m, t) : globalThis.postMessage(m, t);

async function onDecode({ data }) {
  if (data.type !== "attr") return;
  try {
    const { N, streams, recon } = data;
    const C = recon.component;
    let codes = new Int32Array(N * C);
    for (const s of streams) {
      const raw = s.entropy ? zstdDecompress(s.data) : s.data;
      if (raw.length !== N * C)
        throw new Error(`Stream length ${raw.length} != ${N * C}.`);
      const mult = 2 ** s.byteshift;
      if (mult === 1) for (let i = 0; i < N * C; i++) codes[i] += raw[i];
      else for (let i = 0; i < N * C; i++) codes[i] += raw[i] * mult;
    }
    if (recon.prediction) {
      const levels = 2 ** recon.prediction.byteshift;
      const rows = recon.prediction.blockSize ** 2;
      for (let c = 0; c < C; c++) {
        let run = 0;
        for (let n = 0; n < N; n++) {
          if (n % rows === 0) run = 0;
          const i = n * C + c;
          const v = codes[i];
          run = (run + ((v / levels) | 0)) & 255;
          codes[i] = run * levels + (v % levels);
        }
      }
    }
    const levels = 2 ** recon.bits - 1;
    const out = new Float32Array(N * C);
    let opacity64 = null;
    if (recon.quant.kind === "minmax") {
      const mn = recon.quant.min, mx = recon.quant.max;
      const rng = new Float64Array(C);
      for (let c = 0; c < C; c++) rng[c] = mx[c] - mn[c] + 1e-6;
      if (recon.isOpacity) opacity64 = new Float64Array(N);
      for (let n = 0; n < N; n++)
        for (let c = 0; c < C; c++) {
          const t1 = F(codes[n * C + c] / levels);
          const v = t1 * rng[c] + mn[c];
          if (opacity64) opacity64[n] = v;
          out[n * C + c] = F(v);
        }
    } else {
      if (recon.isOpacity) opacity64 = new Float64Array(N);
      // Precompute per-point min/range for every channel once (vectorized
      // expansion of the patch table), then a single flat loop. Numerically
      // identical: same f32 division, f64 multiply-add, single fround.
      const mins = new Float64Array(N * C);
      const rngs = new Float64Array(N * C);
      let off = 0;
      for (const p of rec_quant_patches(recon)) {
        for (let n = off; n < off + p.size; n++)
          for (let c = 0; c < C; c++) {
            const i = n * C + c;
            mins[i] = p.min[c];
            rngs[i] = p.max[c] - p.min[c] + 1e-6;
          }
        off += p.size;
      }
      for (let i = 0; i < N * C; i++) {
        out[i] = F(F(codes[i] / levels) * rngs[i] + mins[i]);
      }
      // opacity always quantizes minmax; the patch branch never emits opacity64
    }
    const transfer = [out.buffer];
    if (opacity64) transfer.push(opacity64.buffer);
    post({ type: "done", out, opacity64 }, transfer);
  } catch (error) {
    post({ type: "error", message: String(error?.message ?? error) });
  }
}

if (nodePort) nodePort.on("message", (data) => onDecode({ data }));
else globalThis.onmessage = onDecode;
