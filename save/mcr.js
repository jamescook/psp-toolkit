// PS1 memory card (MCR) directory parser
//
// A raw PS1 memory card is 131072 bytes (128KB): block 0 is the directory
// (fifteen 128-byte header frames, one per save slot), blocks 1-15 are the
// 8192-byte save-data blocks those frames describe.
//
// Only the 'initial' frame of a save carries a meaningful size — a save that
// spans multiple blocks continues into 'middle-link'/'end-link' frames whose
// own size fields are unused. Callers building a save list should filter to
// type === 'initial' for one row per real save; this module exposes all 15
// slots as-is so every state (including corrupted/deleted) is inspectable.
//
// Byte layout per 128-byte header frame, cross-checked against
// bucanero/apollo-psp's ps1card.c (loadSlotTypes/loadStringData/loadSaveSize):
//   +0x00  1 byte    Block state (see BLOCK_TYPES)
//   +0x04  3 bytes   Save size in bytes, little-endian (initial frame only)
//   +0x0A  20 bytes  Filename field, itself split into:
//     +0x0A  2 bytes   Region ("BA" America, "BE" Europe, "BI" Japan)
//     +0x0C  10 bytes  Product code (e.g. "SLUS-00594")
//     +0x16  8 bytes   Identifier suffix

export const MCR_SIZE = 131072;
export const BLOCK_SIZE = 8192;
export const HEADER_SIZE = 128;
export const MAX_SLOTS = 15;

const BLOCK_TYPES = {
  0xa0: 'formatted',
  0x51: 'initial',
  0x52: 'middle-link',
  0x53: 'end-link',
  0xa1: 'deleted-initial',
  0xa2: 'deleted-middle-link',
  0xa3: 'deleted-end-link',
};

/**
 * Parse a raw 128KB PS1 memory card image into its 15 directory slots.
 * @param {Uint8Array} data - raw MCR bytes
 * @returns {Array<{index:number,type:string,size:number,region:string,productCode:string,identifier:string,name:string}>}
 */
export function parseMcr(data) {
  if (data.length !== MCR_SIZE) {
    throw new Error(`Expected a ${MCR_SIZE}-byte memory card, got ${data.length}`);
  }

  const slots = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const header = data.subarray(i * HEADER_SIZE, (i + 1) * HEADER_SIZE);
    slots.push({
      index: i,
      type: BLOCK_TYPES[header[0]] || 'corrupted',
      size: header[4] | (header[5] << 8) | (header[6] << 16),
      region: asciiSlice(header, 0x0a, 2),
      productCode: asciiSlice(header, 0x0c, 10),
      identifier: asciiSlice(header, 0x16, 8),
      name: asciiSlice(header, 0x0a, 20),
    });
  }
  return slots;
}

/** Read up to `len` bytes as ASCII, stopping at the first null byte. */
function asciiSlice(buf, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = buf[start + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}
