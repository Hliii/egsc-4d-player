// Inline (no-worker) attribute decode: identical math to attr-worker.js,
// used by Node smoke tests where Worker is unavailable.
import { decompress as zstdDecompress } from "./vendor/fzstd.js";

const F = Math.fround;

export function attrDecodeInline(name, streams, rec, N) {
  const C = rec.component;
  const codes = new Int32Array(N * C);
  for (const s of streams) {
    const raw = s.entropy ? zstdDecompress(s.data) : s.data;
    const mult = 2 ** s.byteshift;
    if (mult === 1) for (let i = 0; i < N * C; i++) codes[i] += raw[i];
    else for (let i = 0; i < N * C; i++) codes[i] += raw[i] * mult;
  }
  if (rec.prediction) {
    const levels = 2 ** rec.prediction.byteshift;
    const rows = rec.prediction.blockSize ** 2;
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
  const levels = 2 ** rec.bits - 1;
  const out = new Float32Array(N * C);
  const opacity64 = name === "opacity" ? new Float64Array(N) : null;
  if (rec.quant.kind === "minmax") {
    const mn = rec.quant.min, mx = rec.quant.max;
    const rng = new Float64Array(C);
    for (let c = 0; c < C; c++) rng[c] = mx[c] - mn[c] + 1e-6;
    for (let n = 0; n < N; n++)
      for (let c = 0; c < C; c++) {
        const t1 = F(codes[n * C + c] / levels);
        const v = t1 * rng[c] + mn[c];
        if (opacity64) opacity64[n] = v;
        out[n * C + c] = F(v);
      }
  } else {
    // Vectorized patch dequant (identical math/order to the worker path).
    const mins = new Float64Array(N * C);
    const rngs = new Float64Array(N * C);
    let off = 0;
    for (const p of rec.quant.patches) {
      for (let n = off; n < off + p.size; n++)
        for (let c = 0; c < C; c++) {
          const i = n * C + c;
          mins[i] = p.min[c];
          rngs[i] = p.max[c] - p.min[c] + 1e-6;
        }
      off += p.size;
    }
    for (let i = 0; i < N * C; i++)
      out[i] = F(F(codes[i] / levels) * rngs[i] + mins[i]);
  }
  return { out, opacity64 };
}
