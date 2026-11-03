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

/** Chunked model assembly in a worker pool (fallback: inline). */
function dispatchModelChunk(data) {
  return new Promise((resolve, reject) => {
    const w = createModuleWorker(new URL("./model-worker.js", import.meta.url));
    w.onmessage = ({ data: r }) => { w.terminate(); resolve(r); };
    w.onerror = (e) => { w.terminate(); reject(new Error(`model worker: ${e.message}`)); };
    // Only transfer the chunk's own slice of each attribute (rows
    // [start, end)); one standalone buffer per array per chunk.
    const layout = { // per-row component count
      means: 3, velocity: 3, time: 1, logDuration: 1, opacity: 1,
      scaling: 3, rotation: 4, sh0: 3,
    };
    const msg = { type: "chunk", start: data.start, end: data.end,
      coefficients: data.coefficients, minDuration: data.minDuration };
    const transfer = [];
    for (const [k, C] of Object.entries(layout)) {
      const arr = data[k];
      if (!arr) { msg[k] = null; continue; }
      const from = data.start * C, to = data.end * C;
      const copy = arr.constructor.from(arr.subarray(from, to));
      msg[k] = copy;
      transfer.push(copy.buffer);
    }
    // shN: per point 3*K values (K = coefficients - 1)
    if (data.shN) {
      const K = data.coefficients - 1;
      const from = data.start * 3 * K, to = data.end * 3 * K;
      const copy = Float32Array.from(data.shN.subarray(from, to));
      msg.shN = copy;
      transfer.push(copy.buffer);
    }
    w.postMessage(msg, transfer);
  });
}

const F = Math.fround;

/** Texture depack+dequant in a worker (parallel with the attr pool). */
function dispatchTex(img, meta, rec, N) {
  return new Promise((resolve, reject) => {
    const w = createModuleWorker(new URL("./tex-worker.js", import.meta.url));
    w.onmessage = ({ data }) => {
      w.terminate();
      if (data.type === "done") resolve(data.out);
      else reject(new Error(data.message));
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(`tex worker: ${e.message}`)); };
    const copy = Uint8Array.from(img);  // img may be a subarray/view
    w.postMessage({ type: "tex", img: copy, meta, rec, N }, [copy.buffer]);
  });
}

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

  // ---- 2. texture: ASTC decode (coordinator) -> depack+dequant (worker) ----
  let texOut = null, texAttr = null;
  const texJob = (async () => {
    if (!texStream) return;
    let t = Date.now();
    const raw = texStream.meta.entropy
      ? (await import("./vendor/fzstd.js")).decompress(texStream.data)
      : texStream.data;
    const astc = parseAstcHeader(raw);
    if (!decodeAstc) throw new Error("This stream needs an ASTC decoder.");
    const img = await decodeAstc(astc.data, astc.width, astc.height, astc.blockX, astc.blockY);
    timings.astc += Date.now() - t;
    t = Date.now();
    const meta = texStream.meta;
    const rec = recon[texStream.attrName];
    let out;
    if (useWorkers) {
      out = await dispatchTex(img, meta, rec, N);
    } else {
      // inline fallback: same math as tex-worker
      const { texDecodeInline } = await import("./tex-inline.js");
      out = texDecodeInline(img, meta, rec, N);
    }
    timings.depack += Date.now() - t;
    texOut = out;
    texAttr = texStream.attrName;
  })();

  // ---- 3. entropy attributes: workers (zstd+merge+DPCM+dequant), in
  // parallel with the texture job above ----
  // Progress: each completed substream (attr or texture) advances the
  // 0.05..0.8 decode window proportionally; the assembly chunks below
  // cover 0.8..0.95.
  const progress = opts.onProgress ?? (() => {});
  const entries = [...byAttr.entries()];
  const totalJobs = entries.length + (texStream ? 1 : 0);
  let doneJobs = 0;
  const tick = () => progress(0.05 + 0.75 * (++doneJobs / totalJobs));
  const t = Date.now();
  let attrResults;
  if (useWorkers) {
    attrResults = await Promise.all([
      texJob.then(tick),
      ...entries.map(([name, list]) =>
        dispatchAttr(name, list, recon[name], N).then((r) => (tick(), r))),
    ]);
    attrResults = [undefined, ...attrResults.slice(1)];
  } else {
    const { attrDecodeInline } = await import("./attr-inline.js");
    await texJob;
    attrResults = [
      undefined,
      ...entries.map(([name, list]) => { const r = attrDecodeInline(name, list, recon[name], N); tick(); return r; }),
    ];
  }
  timings.attrs = (timings.attrs ?? 0) + (Date.now() - t);

  const splats = {};
  let opacity64 = null;
  if (texOut) splats[texAttr] = texOut;
  for (let i = 0; i < entries.length; i++) {
    const [name] = entries[i];
    splats[name] = attrResults[i + 1].out;
    if (attrResults[i + 1].opacity64) opacity64 = attrResults[i + 1].opacity64;
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

/** Convert decoded splats to the player model contract (see ftgs.js).
 *  Chunk-parallel across a worker pool when available; inline fallback. */
export async function splatToPlayerModel(splats, meta = {}) {
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
  const useWorkers = typeof Worker === "function" && count >= 65536;
  if (useWorkers) {
    const CH = 8;
    const per = Math.ceil(count / CH);
    const chunks = [];
    for (let c = 0; c < CH; c++) {
      const start = c * per;
      if (start >= count) break;
      const end = Math.min(count, start + per);
      chunks.push({ type: "chunk", start, end,
        means: splats.means, velocity: splats.velocity, time: splats.time,
        logDuration: splats.log_duration, opacity: splats.opacity,
        scaling: splats.scaling, rotation: splats.rotation,
        sh0: splats.features_dc, shN: splats.features_rest,
        coefficients, minDuration });
    }
    const onChunk = meta.onProgress;
    let doneChunks = 0;
    const results = await Promise.all(chunks.map((c) =>
      dispatchModelChunk(c).then((r) => {
        if (onChunk) onChunk((++doneChunks / chunks.length));
        return r;
      })));
    for (const r of results) {
      model.positionTime.set(r.positionTime, r.start * 4);
      model.velocityDuration.set(r.velocityDuration, r.start * 4);
      model.covarianceA.set(r.covarianceA, r.start * 4);
      model.covarianceB.set(r.covarianceB, r.start * 4);
      model.sh.set(r.sh, r.start * coefficients * 4);
      model.alpha.set(r.alpha, r.start);
    }
  } else {
    const K = coefficients - 1;
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
