// EGSC decode pipeline: zstd + ASTC substreams -> depack -> prediction
// inverse -> dequant -> opacity filter -> splat arrays.
//
// Layout: decodeSubset coordinates two worker pools — ASTC strip workers
// (egsc-astc.js) and per-attribute workers (attr-worker.js, one task per
// attribute covering zstd + lsb/msb merge + DPCM + dequant). The
// coordinator keeps only the texture depack, opacity filter and the
// features_rest coefficient/channel transposition.
//
// Numerics note: the Python decoder dequantizes with a float32
// q/levels step and a float64 (max-min+1e-6)*+min step, rounding to
// float32 once at the end (and the opacity filter compares the float64
// value). The workers mirror that exactly via Math.fround.

import { parseEGSC, parseAstcHeader } from "./egsc.js";
import { covarianceFromQuaternion } from "./ftgs.js";
import { createModuleWorker } from "./worker.js";

const F = Math.fround;

function dispatchAttr(name, streams, rec, N) {
  // streams: [{data (Uint8Array subarray of the bitstream), byteshift, entropy}]
  return new Promise((resolve, reject) => {
    const w = createModuleWorker(new URL("./attr-worker.js", import.meta.url));
    w.onmessage = ({ data }) => {
      if (data.type === "done") { w.terminate(); resolve(data); }
      else { w.terminate(); reject(new Error(data.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(`attr worker: ${e.message}`)); };
    // subarrays share the bitstream buffer; copy each so the transfer list
    // holds distinct ArrayBuffers (and the source stream stays usable).
    const copies = streams.map((s) => {
      const c = new Uint8Array(s.data.length);
      c.set(s.data);
      return { data: c, byteshift: s.byteshift, entropy: s.entropy };
    });
    const transfer = copies.map((c) => c.data.buffer);
    w.postMessage({
      type: "attr", N,
      recon: { ...rec, isOpacity: name === "opacity" },
      streams: copies,
    }, transfer);
  });
}

async function decodeSubset(egsc, subset, decodeAstc, timings, opts = {}) {
  const N = subset.numPoints;
  const recon = subset.reconstruction;
  const streams = egsc.streams.filter((s) => s.subsetId === subset.id);
  const useWorkers = opts.attrWorkers !== false && typeof Worker === "function";

  // ---- 1. group substreams by attribute ----
  const byAttr = new Map();
  let texStream = null;
  for (const s of streams) {
    if (s.type === 1) { texStream = s; continue; }
    const rec = recon[s.attrName];
    if (!rec) throw new Error(`No reconstruction info for stream ${s.attrName}.`);
    if (!byAttr.has(s.attrName)) byAttr.set(s.attrName, []);
    byAttr.get(s.attrName).push({
      data: s.data, byteshift: s.meta.byteshift, entropy: s.meta.entropy,
    });
  }

  // ---- 2. texture: ASTC decode + depack (coordinator) ----
  let texCodes = null, texRec = null;
  if (texStream) {
    let t = Date.now();
    const raw = texStream.meta.entropy
      ? (await import("./vendor/fzstd.mjs")).decompress(texStream.data)
      : texStream.data;
    const astc = parseAstcHeader(raw);
    if (!decodeAstc) throw new Error("This stream needs an ASTC decoder.");
    const img = await decodeAstc(astc.data, astc.width, astc.height, astc.blockX, astc.blockY);
    timings.astc += Date.now() - t;
    t = Date.now();
    const meta = texStream.meta;
    const rec = recon[texStream.attrName];
    const q = new Int32Array(N * rec.component);
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
          const b = n * rec.component + cOff;
          q[b] = img[p]; q[b + 1] = img[p + 1]; q[b + 2] = img[p + 2];
        }
      }
    }
    timings.depack += Date.now() - t;
    texCodes = q;
    texRec = rec;
  }

  // ---- 3. entropy attributes: workers (zstd+merge+DPCM+dequant) ----
  const t = Date.now();
  const entries = [...byAttr.entries()];
  let attrResults;
  if (useWorkers) {
    attrResults = await Promise.all(
      entries.map(([name, list]) => dispatchAttr(name, list, recon[name], N)),
    );
  } else {
    // inline path (Node tests without Worker): same math as attr-worker
    const { attrDecodeInline } = await import("./attr-inline.js");
    attrResults = entries.map(([name, list]) =>
      attrDecodeInline(name, list, recon[name], N));
  }
  timings.attrs = (timings.attrs ?? 0) + (Date.now() - t);

  const splats = {};
  let opacity64 = null;
  for (let i = 0; i < entries.length; i++) {
    const [name] = entries[i];
    splats[name] = attrResults[i].out;
    if (attrResults[i].opacity64) opacity64 = attrResults[i].opacity64;
  }
  // texture attribute dequant (kept inline: patch quant over Int32 codes)
  if (texCodes) {
    const rec = texRec;
    const levels = 2 ** rec.bits - 1;
    const C = rec.component;
    const out = new Float32Array(N * C);
    if (rec.quant.kind === "minmax") {
      const mn = rec.quant.min, mx = rec.quant.max;
      const rng = new Float64Array(C);
      for (let c = 0; c < C; c++) rng[c] = mx[c] - mn[c] + 1e-6;
      for (let n = 0; n < N; n++)
        for (let c = 0; c < C; c++)
          out[n * C + c] = F(F(texCodes[n * C + c] / levels) * rng[c] + mn[c]);
    } else {
      let off = 0;
      for (const p of rec.quant.patches) {
        const rng = new Float64Array(C);
        for (let c = 0; c < C; c++) rng[c] = p.max[c] - p.min[c] + 1e-6;
        for (let n = off; n < off + p.size; n++)
          for (let c = 0; c < C; c++)
            out[n * C + c] = F(F(texCodes[n * C + c] / levels) * rng[c] + p.min[c]);
        off += p.size;
      }
    }
    splats[texStream.attrName] = out;
  }

  // features_rest depack layout is coef-major (k*3+ch, mirrors the (N,15,3)
  // tensor flatten); the PLY/player contract is channel-major (ch*15+k).
  if (splats.features_rest) {
    const src = splats.features_rest;
    const dst = new Float32Array(src.length);
    const K = src.length / N / 3;
    for (let n = 0; n < N; n++)
      for (let k = 0; k < K; k++)
        for (let ch = 0; ch < 3; ch++)
          dst[n * 3 * K + ch * K + k] = src[n * 3 * K + k * 3 + ch];
    splats.features_rest = dst;
  }

  // ---- 4. opacity filter (float64 compare, mirrors decode_streamer) ----
  let count = 0;
  for (let n = 0; n < N; n++) if (opacity64[n] >= -10) count++;
  const idx = new Int32Array(count);
  let j = 0;
  for (let n = 0; n < N; n++) if (opacity64[n] >= -10) idx[j++] = n;

  const filtered = {};
  for (const [name, arr] of Object.entries(splats)) {
    const C = arr.length / N;
    const out = new Float32Array(count * C);
    for (let i = 0; i < count; i++) {
      const src = idx[i] * C, dst = i * C;
      for (let c = 0; c < C; c++) out[dst + c] = arr[src + c];
    }
    filtered[name] = out;
  }
  return { ...filtered, count, numPoints: N };
}

/** Decode an .egsc bitstream. opts.decodeAstc: async (blockData, w, h, bx, by)
 *  -> RGBA Uint8Array (required when the stream contains an ASTC texture). */
export async function decodeEGSC(bytes, opts = {}) {
  const egsc = parseEGSC(bytes);
  if (egsc.nSubsets !== 1)
    throw new Error("Multi-subset streams are not supported yet.");
  const timings = { zstd: 0, astc: 0, depack: 0, attrs: 0 };
  let t = Date.now();
  const subset = await decodeSubset(egsc, egsc.subsets[0], opts.decodeAstc, timings, opts);
  timings.total = Date.now() - t;
  return { splats: subset, shDegree: egsc.shDegree, timings };
}

/** Convert decoded splats to the player model contract (see ftgs.js). */
export function splatToPlayerModel(splats, meta = {}) {
  const count = splats.count;
  const degree = meta.shDegree ?? 3;
  const coefficients = (degree + 1) ** 2;
  const useVelocity = meta.useVelocity ?? true;
  const minDuration = meta.minDuration ?? 0.02;
  const opacityFloor = meta.opacityFloor ?? 1e-4;
  const model = {
    format: "egsc",
    timelineMode: 0,
    count, degree, coefficients, useVelocity, minDuration, opacityFloor,
    nFrames: meta.nFrames ?? null,
    positionTime: new Float32Array(count * 4),
    velocityDuration: new Float32Array(count * 4),
    covarianceA: new Float32Array(count * 4),
    covarianceB: new Float32Array(count * 4),
    sh: new Float32Array(count * coefficients * 4),
    alpha: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const o4 = i * 4, o3 = i * 3;
    model.positionTime[o4] = splats.means[o3];
    model.positionTime[o4 + 1] = splats.means[o3 + 1];
    model.positionTime[o4 + 2] = splats.means[o3 + 2];
    model.positionTime[o4 + 3] = splats.time[i];
    const duration = Math.max(minDuration, Math.exp(splats.log_duration[i]));
    model.velocityDuration[o4] = splats.velocity[o3];
    model.velocityDuration[o4 + 1] = splats.velocity[o3 + 1];
    model.velocityDuration[o4 + 2] = splats.velocity[o3 + 2];
    model.velocityDuration[o4 + 3] = duration;
    const cov = covarianceFromQuaternion(
      [splats.rotation[i * 4], splats.rotation[i * 4 + 1], splats.rotation[i * 4 + 2], splats.rotation[i * 4 + 3]],
      [splats.scaling[o3], splats.scaling[o3 + 1], splats.scaling[o3 + 2]],
    );
    model.covarianceA.set(cov.slice(0, 4), o4);
    const alpha = 1 / (1 + Math.exp(-splats.opacity[i]));
    model.covarianceB.set([cov[4], cov[5], alpha, 0], o4);
    model.alpha[i] = alpha;
    for (let coefficient = 0; coefficient < coefficients; coefficient++) {
      for (let channel = 0; channel < 3; channel++) {
        const v = coefficient === 0
          ? splats.features_dc[i * 3 + channel]
          : splats.features_rest[i * 45 + channel * (coefficients - 1) + coefficient - 1];
        model.sh[(i * coefficients + coefficient) * 4 + channel] = v;
      }
    }
  }
  // bounds (central 98%, as in readFTGS)
  const axes = [[], [], []];
  const step = Math.max(1, Math.floor(count / 4 / 8192));
  for (let i = 0; i < count; i += step)
    for (let a = 0; a < 3; a++) axes[a].push(model.positionTime[i * 4 + a]);
  const lo = [], hi = [];
  for (const values of axes) {
    values.sort((a, b) => a - b);
    lo.push(values[Math.floor((values.length - 1) * 0.01)]);
    hi.push(values[Math.ceil((values.length - 1) * 0.99)]);
  }
  model.bounds = {
    min: lo, max: hi,
    center: lo.map((v, i) => (v + hi[i]) / 2),
    radius: Math.max(0.01, Math.hypot(...lo.map((v, i) => hi[i] - v)) / 2),
  };
  return model;
}
