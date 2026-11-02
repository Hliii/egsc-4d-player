// Strip worker for the WASM ASTC decoder (BGRA -> RGBA conversion here).
// Works in browser module workers (self.onmessage) and node:worker_threads
// (imported parentPort) so the decode stack is testable from Node.
//
// The handler must be attached synchronously: in a module worker, messages
// posted while a top-level await is pending fire before the script finishes,
// so any await-before-onmessage drops them.
import { decode_astc, initialize } from "./vendor/texture2ddecoder.mjs";

let nodePort = null;
let postMsg = (m, t) => globalThis.postMessage(m, t);
const isNode = typeof process !== "undefined" && process.versions?.node;

const ready = (async () => {
  if (isNode) {
    ({ parentPort: nodePort } = await import("node:worker_threads"));
    postMsg = (m, t) => nodePort.postMessage(m, t);
    nodePort.on("message", (data) => onDecode(data));
  } else {
    // Browser: the vendored decoder needs the wasm directory explicitly.
    await initialize({ wasmPath: new URL("./vendor/wasm/", import.meta.url).href });
  }
})();

async function onDecode(data) {
  if (data.type !== "decode") return;
  try {
    await ready;
    const bgra = await decode_astc(data.data, data.width, data.bandHeight, data.bx, data.by);
    if (!bgra) throw new Error("ASTC WASM decode failed");
    const rgba = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = bgra[i + 3];
    }
    postMsg({ type: "done", pixels: rgba }, [rgba.buffer]);
  } catch (error) {
    postMsg({ type: "error", message: String(error?.message ?? error) });
  }
}

if (!isNode) globalThis.onmessage = ({ data }) => onDecode(data);
