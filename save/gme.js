// GME (DexDrive) memory card container
//
// A .gme file is a DexDrive-format wrapper around a raw PS1 memory card: a
// 3904-byte DexDrive header (magic, per-slot comments, icon overrides — not
// needed just to reach the card data) followed by the verbatim 131072-byte
// raw card payload.
//
// Cross-checked against bucanero/apollo-psp's ps1card.c, which detects GME
// by the same "123-456-STD" magic at offset 0 and hardcodes the same
// 3904-byte offset to the card payload.

import { MCR_SIZE, HEADER_SIZE, MAX_SLOTS } from './mcr.js';

export const GME_HEADER_SIZE = 3904;
export const GME_SIZE = GME_HEADER_SIZE + MCR_SIZE;
export const GME_MAGIC = '123-456-STD';

// Per-slot fields within the header, cross-checked against apollo-psp's
// ps1card.c (fillGmeHeader) and byte-diffed against a real DexDrive-produced
// .gme (chrono-cross.4587.gme): a 15-byte block-state array at +22 and a
// 15-byte next-slot-link array at +38 (both copied verbatim from each slot's
// own MCR header frame), plus flag bytes at +18/+20/+21 whose meaning isn't
// documented upstream but are always 0x01/0x01/0x4D ('M') on a real card.
const GME_STATE_ARRAY_OFFSET = 22;
const GME_NEXT_ARRAY_OFFSET = 38;

/**
 * Strip a .gme file's DexDrive header, returning the raw PS1 memory card payload.
 * @param {Uint8Array} data - raw .gme bytes
 * @returns {Uint8Array} the raw 131072-byte memory card, ready for parseMcr()
 */
export function stripGmeHeader(data) {
  if (data.length !== GME_SIZE) {
    throw new Error(`Expected a ${GME_SIZE}-byte .gme file (131072-byte card + 3904-byte DexDrive header), got ${data.length}`);
  }

  const magic = bytesToAscii(data, 0, GME_MAGIC.length);
  if (magic !== GME_MAGIC) {
    throw new Error(`Not a DexDrive .gme file — expected magic "${GME_MAGIC}", got "${magic}"`);
  }

  return data.subarray(GME_HEADER_SIZE);
}

/**
 * Wrap a raw 128KB PS1 memory card in a DexDrive-format .gme header.
 *
 * Per-slot comments (256 bytes/slot, holding a free-text save description in
 * real DexDrive-family tools) are left zeroed -- they're not derivable from
 * the raw MCR itself, and a real card's comments are commonly blank too (as
 * in chrono-cross.4587.gme, used to verify this header layout).
 *
 * @param {Uint8Array} mcr - raw memory card, exactly MCR_SIZE bytes
 * @returns {Uint8Array} a complete GME_SIZE-byte .gme file
 */
export function wrapGme(mcr) {
  if (mcr.length !== MCR_SIZE) {
    throw new Error(`Expected a ${MCR_SIZE}-byte memory card, got ${mcr.length}`);
  }

  const header = new Uint8Array(GME_HEADER_SIZE);
  for (let i = 0; i < GME_MAGIC.length; i++) header[i] = GME_MAGIC.charCodeAt(i);
  header[18] = 0x01;
  header[20] = 0x01;
  header[21] = 0x4d; // 'M'

  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const frameOff = HEADER_SIZE * (slot + 1);
    header[GME_STATE_ARRAY_OFFSET + slot] = mcr[frameOff];
    header[GME_NEXT_ARRAY_OFFSET + slot] = mcr[frameOff + 8];
  }
  // Comment fields (offset 64 + slot*256, 256 bytes each) stay zeroed --
  // see doc comment above.

  const out = new Uint8Array(GME_SIZE);
  out.set(header, 0);
  out.set(mcr, GME_HEADER_SIZE);
  return out;
}

function bytesToAscii(buf, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[start + i]);
  return s;
}
