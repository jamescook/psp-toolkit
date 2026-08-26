// PS1 memory card (MCR) directory parser
//
// A raw PS1 memory card is 131072 bytes (128KB), organized as 16 blocks of
// 8192 bytes each. Block 0 is the directory block, itself sixty-four 128-byte
// frames: frame 0 is the card's own ID/signature frame (not a save slot),
// frames 1-15 are the 15 save-slot header frames, frames 16-63 are reserved
// (broken-sector list, a write-test frame, etc). So slot i's header frame
// lives at byte offset HEADER_SIZE*(i+1), NOT HEADER_SIZE*i -- an easy
// off-by-one since there are exactly MAX_SLOTS (15) slots, tempting you to
// index the directory block directly by slot number starting at 0. Blocks
// 1-15 are the corresponding 8192-byte save-data blocks, same "+1" shift
// (block 0 is the directory, not slot 0's data).
//
// Only the 'initial' frame of a save carries a meaningful size — a save that
// spans multiple blocks continues into 'middle-link'/'end-link' frames whose
// own size fields are unused. Callers building a save list should filter to
// type === 'initial' for one row per real save; this module exposes all 15
// slots as-is so every state (including corrupted/deleted) is inspectable.
//
// Byte layout per 128-byte header frame, cross-checked against
// bucanero/apollo-psp's ps1card.c (loadDataFromRawCard/loadSlotTypes/
// loadStringData/loadSaveSize):
//   +0x00  1 byte    Block state (see BLOCK_TYPES)
//   +0x04  3 bytes   Save size in bytes, little-endian (initial frame only)
//   +0x08  1 byte    Next-slot link (see findSaveLinks) -- 0xFF = end of chain
//   +0x0A  20 bytes  Filename field, itself split into:
//     +0x0A  2 bytes   Region ("BA" America, "BE" Europe, "BI" Japan)
//     +0x0C  10 bytes  Product code (e.g. "SLUS-00594")
//     +0x16  8 bytes   Identifier suffix

export const MCR_SIZE = 131072;
export const BLOCK_SIZE = 8192;
export const HEADER_SIZE = 128;
export const MAX_SLOTS = 15;
const NEXT_SLOT_OFFSET = 0x08;
const NO_NEXT_SLOT = 0xff;

const BLOCK_TYPES = {
  0xa0: 'formatted',
  0x51: 'initial',
  0x52: 'middle-link',
  0x53: 'end-link',
  0xa1: 'deleted-initial',
  0xa2: 'deleted-middle-link',
  0xa3: 'deleted-end-link',
};

function requireMcrSize(data) {
  if (data.length !== MCR_SIZE) {
    throw new Error(`Expected a ${MCR_SIZE}-byte memory card, got ${data.length}`);
  }
}

function headerFrame(data, slot) {
  const off = HEADER_SIZE * (slot + 1);
  return data.subarray(off, off + HEADER_SIZE);
}

function blockTypeOf(header) {
  return BLOCK_TYPES[header[0]] || 'corrupted';
}

/**
 * Parse a raw 128KB PS1 memory card image into its 15 directory slots.
 * @param {Uint8Array} data - raw MCR bytes
 * @returns {Array<{index:number,type:string,size:number,region:string,productCode:string,identifier:string,name:string}>}
 */
export function parseMcr(data) {
  requireMcrSize(data);

  const slots = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const header = headerFrame(data, i);
    slots.push({
      index: i,
      type: blockTypeOf(header),
      size: header[4] | (header[5] << 8) | (header[6] << 16),
      region: asciiSlice(header, 0x0a, 2),
      productCode: asciiSlice(header, 0x0c, 10),
      identifier: asciiSlice(header, 0x16, 8),
      name: asciiSlice(header, 0x0a, 20),
    });
  }
  return slots;
}

/**
 * Walk a save's multi-block chain starting at `slotIndex`, mirroring
 * apollo-psp's findSaveLinks(): follows each frame's next-slot link byte
 * (offset 0x08) until the 0xFF end-of-chain sentinel, an out-of-range link,
 * or a corrupted frame is hit. Capped at MAX_SLOTS iterations as a guard
 * against a cyclic/malformed chain looping forever.
 * @returns {number[]} slot indices in chain order (always at least [slotIndex])
 */
export function findSaveLinks(data, slotIndex) {
  requireMcrSize(data);

  const chain = [];
  let current = slotIndex;
  for (let i = 0; i < MAX_SLOTS; i++) {
    chain.push(current);
    const header = headerFrame(data, current);
    if (blockTypeOf(header) === 'corrupted') break;
    const next = header[NEXT_SLOT_OFFSET];
    if (next === NO_NEXT_SLOT || next >= MAX_SLOTS) break;
    current = next;
  }
  return chain;
}

/**
 * Build a standalone 128KB memory card containing only the save chain that
 * starts at `slotIndex` -- every other slot is blanked exactly like
 * apollo-psp's formatSlot() (header byte0=0xA0 'formatted', link byte
 * 0x08=0xFF, everything else zero), so the result looks like a freshly
 * formatted card with a single save on it. Intended for slots whose type is
 * 'initial' (the head of an active save's chain); the card ID frame and the
 * directory block's reserved frames (16-63) are preserved verbatim.
 * @param {Uint8Array} data - raw MCR bytes
 * @param {number} slotIndex - index of the save's initial slot
 * @returns {Uint8Array} a new MCR_SIZE-byte memory card
 */
export function extractSaveMcr(data, slotIndex) {
  requireMcrSize(data);

  const chain = new Set(findSaveLinks(data, slotIndex));
  const out = new Uint8Array(MCR_SIZE);
  out.set(data.subarray(0, BLOCK_SIZE)); // directory block: card ID + all header frames, verbatim

  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const headerOff = HEADER_SIZE * (slot + 1);
    const dataOff = BLOCK_SIZE * (slot + 1);
    if (chain.has(slot)) {
      out.set(data.subarray(dataOff, dataOff + BLOCK_SIZE), dataOff);
    } else {
      out.fill(0, headerOff, headerOff + HEADER_SIZE);
      out[headerOff] = 0xa0;
      out[headerOff + NEXT_SLOT_OFFSET] = NO_NEXT_SLOT;
      // data block for a blanked slot is already zero from `new Uint8Array`
    }
  }
  return out;
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
