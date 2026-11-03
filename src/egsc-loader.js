// EGSC loader: Blob -> player model. Wires the ASTC strategy (GPU first,
// parallel WASM fallback) and reads the 4D metadata tail block.

import { decodeEGSC, splatToPlayerModel } from "./egsc-model.js";
import { createAstcDecoder } from "./egsc-astc.js";

const META_TAG = "EGSCMETA4D:";

function readTailMeta(bytes) {
  const tagBytes = new TextEncoder().encode(META_TAG);
  const scanStart = Math.max(0, bytes.length - 4096);
  let tagIdx = -1;
  for (let i = bytes.length - tagBytes.length; i >= scanStart; i--) {
    let ok = true;
    for (let k = 0; k < tagBytes.length; k++)
      if (bytes[i + k] !== tagBytes[k]) { ok = false; break; }
    if (ok) { tagIdx = i; break; }
  }
  if (tagIdx < 0) return {};
  const end = bytes.indexOf(10, tagIdx); // '\n'
  const json = new TextDecoder().decode(
    bytes.subarray(tagIdx + tagBytes.length, end < 0 ? bytes.length : end),
  );
  try { return JSON.parse(json); } catch { return {}; }
}

/** Uniform subsample of the splat arrays (mirrors readFTGS point limiting). */
function limitSplats(splats, maxPoints) {
  // arrays are already opacity-filtered: rows = splats.count (NOT numPoints,
  // which includes discarded padding rows whose rotation is all zeros)
  const N = splats.count;
  const keep = Math.min(N, maxPoints);
  if (keep === N) return splats;
  const out = { count: keep, numPoints: splats.numPoints };
  for (const [name, arr] of Object.entries(splats)) {
    if (typeof arr === "number") continue;
    const C = arr.length / N;
    const dst = new Float32Array(keep * C);
    for (let i = 0; i < keep; i++) {
      const src = Math.floor((i * N) / keep);
      dst.set(arr.subarray(src * C, (src + 1) * C), i * C);
    }
    out[name] = dst;
  }
  return out;
}

export async function readEGSCModel(blob, options = {}) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());
  options.onProgress?.(0.05);
  const meta = readTailMeta(bytes);
  const decodeAstc = createAstcDecoder({ wasmWorkers: 4 });
  const { splats, shDegree } = await decodeEGSC(bytes, { decodeAstc, onProgress: options.onProgress });
  const limited = limitSplats(splats, options.maxPoints ?? 1000000);
  const model = splatToPlayerModel(limited, {
    shDegree,
    nFrames: meta.n_frames ?? 32,
    minDuration: meta.min_duration ?? 0.02,
    opacityFloor: meta.opacity_floor ?? 1e-4,
    useVelocity: meta.use_velocity ?? true,
    onProgress: (p) => options.onProgress?.(0.8 + 0.15 * p),
  });
  model.sourceCount = splats.count;
  options.onProgress?.(1);
  return model;
}
