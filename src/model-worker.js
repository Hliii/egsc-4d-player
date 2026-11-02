// Chunked player-model assembly worker: covariance + SH re-pack for a slice
// of points. Same math as splatToPlayerModel's loop body.
// Works in browser module workers and node:worker_threads.
let nodePort = null;
const isNode = typeof process !== "undefined" && process.versions?.node;
if (isNode) ({ parentPort: nodePort } = await import("node:worker_threads"));

const post = (m, t) =>
  nodePort ? nodePort.postMessage(m, t) : globalThis.postMessage(m, t);

const F = Math.fround;

function covFromQuatLogScales(qx, qy, qz, qw, sx, sy, sz, out6) {
  const norm = Math.hypot(qx, qy, qz, qw);
  const w = qw / norm, x = qx / norm, y = qy / norm, z = qz / norm;
  const r0 = 1 - 2 * (y * y + z * z), r1 = 2 * (x * y - w * z), r2 = 2 * (x * z + w * y);
  const r3 = 2 * (x * y + w * z), r4 = 1 - 2 * (x * x + z * z), r5 = 2 * (y * z - w * x);
  const r6 = 2 * (x * z - w * y), r7 = 2 * (y * z + w * x), r8 = 1 - 2 * (x * x + y * y);
  const s0 = Math.exp(2 * sx), s1 = Math.exp(2 * sy), s2 = Math.exp(2 * sz);
  out6[0] = r0 * r0 * s0 + r1 * r1 * s1 + r2 * r2 * s2;
  out6[1] = r0 * r3 * s0 + r1 * r4 * s1 + r2 * r5 * s2;
  out6[2] = r0 * r6 * s0 + r1 * r7 * s1 + r2 * r8 * s2;
  out6[3] = r3 * r3 * s0 + r4 * r4 * s1 + r5 * r5 * s2;
  out6[4] = r3 * r6 * s0 + r4 * r7 * s1 + r5 * r8 * s2;
  out6[5] = r6 * r6 * s0 + r7 * r7 * s1 + r8 * r8 * s2;
}

function assemble(data) {
  const {
    start, end,
    means, velocity, time, logDuration, opacity, scaling, rotation,
    sh0, shN, coefficients, minDuration,
  } = data;
  const n = end - start;
  const positionTime = new Float32Array(n * 4);
  const velocityDuration = new Float32Array(n * 4);
  const covarianceA = new Float32Array(n * 4);
  const covarianceB = new Float32Array(n * 4);
  const sh = new Float32Array(n * coefficients * 4);
  const alpha = new Float32Array(n);
  const K = coefficients - 1;
  const cov = new Float64Array(6);
  // All input arrays are slice-local (rows [start, end) only): local index i.
  for (let i = 0; i < n; i++) {
    const o4 = i * 4, o3 = i * 3;
    positionTime[o4] = means[o3];
    positionTime[o4 + 1] = means[o3 + 1];
    positionTime[o4 + 2] = means[o3 + 2];
    positionTime[o4 + 3] = time[i];
    const duration = Math.max(minDuration, Math.exp(logDuration[i]));
    velocityDuration[o4] = velocity[o3];
    velocityDuration[o4 + 1] = velocity[o3 + 1];
    velocityDuration[o4 + 2] = velocity[o3 + 2];
    velocityDuration[o4 + 3] = duration;
    covFromQuatLogScales(
      // PLY rot order is wxyz: rot0=w, rot1=x, rot2=y, rot3=z
      rotation[i * 4 + 1], rotation[i * 4 + 2], rotation[i * 4 + 3], rotation[i * 4],
      scaling[o3], scaling[o3 + 1], scaling[o3 + 2], cov,
    );
    covarianceA[o4] = F(cov[0]); covarianceA[o4 + 1] = F(cov[1]);
    covarianceA[o4 + 2] = F(cov[2]); covarianceA[o4 + 3] = F(cov[3]);
    const a = 1 / (1 + Math.exp(-opacity[i]));
    covarianceB[o4] = F(cov[4]); covarianceB[o4 + 1] = F(cov[5]);
    covarianceB[o4 + 2] = a; covarianceB[o4 + 3] = 0;
    alpha[i] = a;
    // sh0: (n,3); shN channel-major (n, 3, K)
    sh[(i * coefficients) * 4] = sh0[o3];
    sh[(i * coefficients) * 4 + 1] = sh0[o3 + 1];
    sh[(i * coefficients) * 4 + 2] = sh0[o3 + 2];
    for (let k = 0; k < K; k++) {
      const o = (i * coefficients + k + 1) * 4;
      const base = i * 3 * K + k;   // channel-major: i*(3K) + ch*K + k
      sh[o] = shN[base];
      sh[o + 1] = shN[base + K];
      sh[o + 2] = shN[base + 2 * K];
    }
  }
  post({ type: "done", start, end,
    positionTime, velocityDuration, covarianceA, covarianceB, sh, alpha },
    [positionTime.buffer, velocityDuration.buffer, covarianceA.buffer,
     covarianceB.buffer, sh.buffer, alpha.buffer]);
}

if (nodePort) nodePort.on("message", (data) => { if (data.type === "chunk") assemble(data); });
else globalThis.onmessage = ({ data }) => { if (data.type === "chunk") assemble(data); };
