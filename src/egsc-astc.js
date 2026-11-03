// ASTC decode strategy for EGSC streams.
// 1. GPU path: OffscreenCanvas + WebGL2 + WEBGL_compressed_texture_astc
//    (mobile GPUs decode natively; desktop usually lacks the extension).
// 2. Fallback: WASM decoder with horizontal strip parallelism across workers.

import { decode_astc as wasmDecode } from "./vendor/texture2ddecoder.js";
import { createModuleWorker } from "./worker.js";

const ASTC_FORMATS = {
  "4x4": 0x93b0, "5x4": 0x93b1, "5x5": 0x93b2, "6x5": 0x93b3, "6x6": 0x93b4,
  "8x5": 0x93b5, "8x6": 0x93b6, "8x8": 0x93b7, "10x5": 0x93b8, "10x6": 0x93b9,
  "10x8": 0x93ba, "10x10": 0x93bb, "12x10": 0x93bc, "12x12": 0x93bd,
};

const VS = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
uniform sampler2D tex;
in vec2 uv;
out vec4 fragColor;
void main() { fragColor = texelFetch(tex, ivec2(gl_FragCoord.xy), 0); }`;

/** Try decoding on the GPU. Returns RGBA Uint8Array or null when unsupported. */
export function astcDecodeGPU(blockData, width, height, bx, by) {
  try {
    if (typeof OffscreenCanvas !== "function") return null;
    const canvas = new OffscreenCanvas(8, 8);
    const gl = canvas.getContext("webgl2", {
      alpha: false, depth: false, stencil: false, antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_compressed_texture_astc");
    const fmt = ASTC_FORMATS[`${bx}x${by}`];
    if (!ext || !fmt) return null;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, fmt, width, height, 0, blockData);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (!complete) {
      // Compressed textures are not always framebuffer-attachable: render
      // through a sampling pass instead.
      const prog = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        gl.attachShader(prog, sh);
      }
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
      const out = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, out);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
      complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      if (!complete) return null;
      gl.viewport(0, 0, width, height);
      gl.useProgram(prog);
      gl.uniform1i(gl.getUniformLocation(prog, "tex"), 0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // GL readback starts at y=0 (bottom) and the block upload also maps data
    // row 0 to y=0, so row order matches the original image; flip to be safe
    // when the sampling path was used (texelFetch keeps y as-is either way).
    return pixels;
  } catch {
    return null;
  }
}

/** WASM strip-parallel decode (BGRA->RGBA per strip). */
async function astcDecodeWasmParallel(blockData, width, height, bx, by, workerCount) {
  const bytesPerBlock = 16;
  const blocksPerRow = Math.ceil(width / bx);
  const totalBlockRows = Math.ceil(height / by);
  const rowsPerWorker = Math.max(1, Math.ceil(totalBlockRows / workerCount));
  const bands = [];
  for (let r0 = 0; r0 < totalBlockRows; r0 += rowsPerWorker) {
    const r1 = Math.min(totalBlockRows, r0 + rowsPerWorker);
    bands.push({ y0: r0 * by, rows: r1 - r0 });
  }
  const out = new Uint8Array(width * height * 4);
  const workers = [];
  const tasks = bands.map((band, i) => new Promise((resolve, reject) => {
    const w = createModuleWorker(new URL("./astc-worker.js", import.meta.url));
    workers.push(w);
    w.onmessage = ({ data }) => {
      if (data.type === "done") {
        // The last band overshoots by block-alignment pixels; copy only
        // the rows that belong to the image.
        const rows = Math.min(band.rows * by, height - band.y0);
        out.set(data.pixels.subarray(0, rows * width * 4), band.y0 * width * 4);
        w.terminate();
        resolve();
      } else if (data.type === "error") {
        w.terminate();
        reject(new Error(data.message));
      }
    };
    w.onerror = (e) => reject(new Error(`astc worker: ${e.message}`));
    const blockRows = band.rows;
    const byteOff = (band.y0 / by) * blocksPerRow * bytesPerBlock;
    const byteLen = blockRows * blocksPerRow * bytesPerBlock;
    const sub = blockData.subarray(byteOff, byteOff + byteLen);
    const buf = new Uint8Array(sub.length);
    buf.set(sub);
    w.postMessage({ type: "decode", data: buf, width, bandHeight: blockRows * by, bx, by }, [buf.buffer]);
  }));
  try {
    await Promise.all(tasks);
  } finally {
    workers.forEach((w) => w.terminate());
  }
  return out;
}

export async function astcDecodeWasm(blockData, width, height, bx, by, workerCount = 4) {
  if (workerCount <= 1) {
    const bgra = await wasmDecode(blockData, width, height, bx, by);
    if (!bgra) throw new Error("ASTC WASM decode failed");
    const rgba = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = bgra[i + 3];
    }
    return rgba;
  }
  return astcDecodeWasmParallel(blockData, width, height, bx, by, workerCount);
}

/** Build the decodeAstc callback used by decodeEGSC: GPU first, WASM parallel fallback. */
export function createAstcDecoder({ tryGPU = true, wasmWorkers = 4 } = {}) {
  let gpuKnown = false, gpuWorks = false;
  const probeGPU = () => {
    if (!gpuKnown) {
      // one 4x4-block probe decides for the whole session
      const zeros = new Uint8Array(16);
      gpuWorks = astcDecodeGPU(zeros, 4, 4, 4, 4) !== null;
      gpuKnown = true;
    }
    return gpuWorks;
  };
  return async (blockData, width, height, bx, by) => {
    if (tryGPU && probeGPU()) {
      const gpu = astcDecodeGPU(blockData, width, height, bx, by);
      if (gpu) return gpu;
    }
    return astcDecodeWasm(blockData, width, height, bx, by, wasmWorkers);
  };
}
