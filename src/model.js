import { readFTGS } from "./ftgs.js";

/** Detect packaged TSOG by its ZIP signature; keep filename-free Blob loading. */
export async function readModel(blob, options = {}) {
  options.signal?.throwIfAborted();
  const signature = new DataView(await blob.slice(0, 4).arrayBuffer());
  if (
    signature.byteLength === 4 &&
    signature.getUint32(0, true) === 0x04034b50
  ) {
    const { readTSOG } = await import("./tsog.js");
    return readTSOG(blob, { compactHarmonics: true, ...options });
  }
  if (await isEGSC(blob)) {
    const { readEGSCModel } = await import("./egsc-loader.js");
    return readEGSCModel(blob, options);
  }
  return {
    ...(await readFTGS(blob, options)),
    format: "ftgs-ply",
    timelineMode: 0,
  };
}

/** EGSC signature: BE metaLen plausible + metadata unit_type 0. */
async function isEGSC(blob) {
  if (blob.size < 16) return false;
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const metaLen = (head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3];
  if (metaLen < 24 || metaLen > 1 << 20 || 8 + metaLen >= blob.size) return false;
  return head[4] >> 4 === 0; // metadata unit type
}
