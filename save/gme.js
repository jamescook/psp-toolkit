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

import { MCR_SIZE } from './mcr.js';

export const GME_HEADER_SIZE = 3904;
export const GME_SIZE = GME_HEADER_SIZE + MCR_SIZE;
export const GME_MAGIC = '123-456-STD';

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

function bytesToAscii(buf, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[start + i]);
  return s;
}
