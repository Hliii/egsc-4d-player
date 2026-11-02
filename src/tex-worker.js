// Texture depack + dequant worker: ASTC-decoded RGBA image -> splat codes
// -> dequantized Float32 attribute. Mirrors the coordinator math exactly.
// Works in browser module workers and node:worker_threads.
let nodePort = null;
const isNode = typeof process !== "undefined" && process.versions?.node;
if (isNode) ({ parentPort: nodePort } = await import("node:worker_threads"));

const post = (m, t) =>
  nodePort ? nodePort.postMessage(m, t) : globalThis.postMessage(m, t);

const F = Math.fround;

function run(d) {
  const { img, meta, rec, N } = d;
  const C = rec.component;
  const q = new Int32Array(N * C);
  const bs = meta.blockSize;
  const d0stride = meta.regionW * bs;
  const d2stride = bs * bs;
  for (let k = 0; k < meta.regions.length; k++) {
    const [tlx, tly] = meta.regions[k];
    const col = tlx / meta.regionW, row = tly / meta.regionH;
    const cOff = meta.chanNum * k;
    for (let tr = 0; tr < meta.regionH; tr++) {
      const d0 = (tr / bs) | 0, d1 = tr % bs;
      const imgRow = row * meta.regionH + tr;
      for (let tc = 0; tc < meta.regionW; tc++) {
        const d2 = (tc / bs) | 0, d3 = tc % bs;
        const imgCol = col * meta.regionW + tc;
        const n = d0 * d0stride + d2 * d2stride + d1 * bs + d3;
        const p = (imgRow * meta.width + imgCol) * 4;
        const b = n * C + cOff;
        q[b] = img[p]; q[b + 1] = img[p + 1]; q[b + 2] = img[p + 2];
      }
    }
  }
  // dequant (same as the coordinator's inline texture dequant)
  const levels = 2 ** rec.bits - 1;
  const out = new Float32Array(N * C);
  if (rec.quant.kind === "minmax") {
    const mn = rec.quant.min, mx = rec.quant.max;
    const rng = new Float64Array(C);
    for (let c = 0; c < C; c++) rng[c] = mx[c] - mn[c] + 1e-6;
    for (let n = 0; n < N; n++)
      for (let c = 0; c < C; c++)
        out[n * C + c] = F(F(q[n * C + c] / levels) * rng[c] + mn[c]);
  } else {
    let off = 0;
    for (const p of rec.quant.patches) {
      const rng = new Float64Array(C);
      for (let c = 0; c < C; c++) rng[c] = p.max[c] - p.min[c] + 1e-6;
      for (let n = off; n < off + p.size; n++)
        for (let c = 0; c < C; c++)
          out[n * C + c] = F(F(q[n * C + c] / levels) * rng[c] + p.min[c]);
      off += p.size;
    }
  }
  post({ type: "done", out }, [out.buffer]);
}

if (nodePort) nodePort.on("message", (d) => { if (d.type === "tex") run(d); });
else globalThis.onmessage = ({ data: d }) => { if (d.type === "tex") run(d); };
