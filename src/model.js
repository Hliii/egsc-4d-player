import { readFTGS } from "./ftgs.js";

const view8 = async (blob, len) =>
  blob instanceof Uint8Array ? blob.subarray(0, len) : new Uint8Array(await blob.slice(0, len).arrayBuffer());

/** Detect packaged TSOG by its ZIP signature; keep filename-free Blob loading. */
export async function readModel(blob, options = {}) {
  options.signal?.throwIfAborted();
  const head = await view8(blob, 8);
  if (head.length >= 4 && (head[0] | head[1] << 8 | head[2] << 16 | head[3] << 24) === 0x04034b50) {
    const { readTSOG } = await import("./tsog.js");
    const blobArg = blob instanceof Uint8Array ? new Blob([blob]) : blob;
    return readTSOG(blobArg, { compactHarmonics: true, ...options });
  }
  if (isEGSCHead(head, blob)) {
    const { readEGSCModel } = await import("./egsc-loader.js");
    // keep the transferred Uint8Array (zero-copy) for the EGSC path
    return readEGSCModel(blob, options);
  }
  const blobArg = blob instanceof Uint8Array ? new Blob([blob]) : blob;
  return {
    ...(await readFTGS(blobArg, options)),
    format: "ftgs-ply",
    timelineMode: 0,
  };
}

/** EGSC signature: BE metaLen plausible + metadata unit_type 0. */
function isEGSCHead(head, blob) {
  const size = blob instanceof Uint8Array ? blob.byteLength : blob.size;
  if (size < 16) return false;
  const metaLen = (head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3];
  if (metaLen < 24 || metaLen > 1 << 20 || 8 + metaLen >= size) return false;
  return head[4] >> 4 === 0; // metadata unit type
}
