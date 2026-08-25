// PSTITLEIMG000000 — multi-disc PSAR wrapper
//
// When a PS1 game spans multiple discs (e.g. FF7 = 3 discs, FF8 = 4 discs),
// the individual PSISOIMG sections are wrapped in a PSTITLEIMG container.
// POPS reads the disc offset table at +0x200 to locate each disc's PSISOIMG.
//
// The header is 0x8000 bytes (32 KB), matching DISC_ALIGN. Each PSISOIMG
// section is also aligned to 0x8000 boundaries. STARTDAT is appended after
// all disc sections.
//
// See docs/eboot-format.md §6 for the full spec.
//
// Header layout:
//   +0x0000  16 bytes   Magic "PSTITLEIMG000000"
//   +0x0010   4 bytes   p1_offset — points to STARTDAT (after all discs)
//   +0x0018  16 bytes   Hash/key constants (4 × uint32 LE, fixed across all Sony EBOOTs)
//   +0x0200  20 bytes   Disc offset table (up to 5 × uint32 LE, zero-terminated)
//   +0x0214  76 bytes   Disc size table (fixed constants from Sony PSN EBOOTs)
//   +0x0264  12 bytes   Primary disc ID ("_SCUS_94163" format)
//   +0x0280   4 bytes   Zero padding
//   +0x0284   4 bytes   p2_offset = p1 + 0x2D31
//   +0x028C 128 bytes   Data3/crypto template (fixed constants, purpose unknown)
//   +0x030C ~128 bytes  Title string (null-terminated)
//   +0x038C   1 byte    0x07 marker
//
// The hash constants, disc size table, and data3/crypto template are identical
// across all examined Sony PSN EBOOTs (FF7, FF8) and are embedded as opaque
// binary blobs in every known popstation implementation (pop-fe's _pstitledata,
// popstationr's data3). Originally extracted from Sony PSN EBOOTs — likely
// DRM/key material that OFW validates but CFW ignores.

import { buildPsisoimg, makeStartdatHeader, makeStartdatLogo, makeStartdatFooter } from './psisoimg.js';

const PSTITLEIMG_MAGIC = 'PSTITLEIMG000000'; // 16 chars (note: 6 trailing zeros, not 4)
const DISC_ALIGN = 0x8000;             // 32 KB — header and disc sections aligned to this
const DISC_OFFSET_TABLE_START = 0x200; // disc offsets in header start here
const MAX_DISCS = 5;                   // POPS supports up to 5 discs
const STARTDAT_CONST = 0x2D31;         // p2 = p1 + this constant

// Fixed hash/key constants at +0x18, present in all examined Sony PSN EBOOTs.
// Purpose unknown — possibly related to DRM/content verification on OFW.
const HEADER_HASH_U32 = [0x2CC9C5BC, 0x33B5A90F, 0x06F6B4B3, 0xB25945BA];

// Fixed disc size table at +0x214 (byte-identical in Sony FF7 and FF8 EBOOTs).
// Confirmed unvalidated by POPS: PSXPackager (github.com/RupertAvery/PSXPackager,
// MultiDiscPbpWriter.cs) fills this same 80-byte span with WriteRandom() — genuine
// random data on every build — and its output plays fine on real hardware regardless
// of disc count. Safe to keep fixed here; no per-disc-count reference dump needed.
// prettier-ignore
const DISC_SIZE_TABLE = new Uint8Array([
  0x29,0x00,0x00,0x00, 0x23,0x48,0x00,0x00, 0xbe,0x18,0x00,0x00, 0x84,0x67,0x00,0x00,
  0xe1,0x4a,0x00,0x00, 0x6c,0x3d,0x00,0x00, 0xd6,0x2c,0x00,0x00, 0xae,0x72,0x00,0x00,
  0x52,0x69,0x00,0x00, 0x90,0x5f,0x00,0x00, 0x49,0x16,0x00,0x00, 0xf1,0x6d,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
]);

// Fixed data3/crypto template at +0x28C (byte-identical in Sony FF7 and FF8 EBOOTs,
// and in PSXPackager's `Popstation.data3` — cross-confirmed, not title/disc-count
// specific). Likely DRM-related key material — ignored by CFW but must be present.
// prettier-ignore
const DATA3_CRYPTO = new Uint8Array([
  0x8c,0x0e,0xae,0x9d,0x39,0x8c,0xfe,0x24,0x65,0x21,0xad,0x2d,0x65,0xa9,0x61,0xdf,
  0xd4,0x4a,0x13,0x03,0xb4,0xcd,0x32,0x5f,0xbd,0xb0,0xf4,0xf9,0x8a,0x70,0xbe,0x1e,
  0x39,0x2c,0x7d,0xc0,0xc1,0xc6,0x6b,0x81,0xaa,0x3c,0x06,0x53,0x94,0x1b,0xce,0xe5,
  0x44,0x16,0xcf,0xdb,0xb1,0xe3,0x89,0x7b,0xa2,0xd2,0xe7,0xd6,0xc1,0x26,0x6b,0x58,
  0x8d,0x2c,0xe6,0xc3,0x15,0x97,0xd0,0x29,0xc9,0x16,0x81,0xb6,0xcc,0x42,0xee,0x0c,
  0x28,0x10,0xea,0xf2,0x6b,0x6f,0x90,0x30,0x05,0xbe,0x4a,0x2f,0x4a,0xbc,0xdc,0xe5,
  0x87,0xce,0x19,0xb9,0x80,0xde,0xb8,0x32,0xdd,0xad,0x89,0x67,0xe0,0x92,0x78,0x89,
  0xe8,0xdc,0x45,0x1d,0x0c,0xbe,0x8b,0x99,0x4d,0x50,0xb3,0xd6,0x58,0x96,0x61,0x75,
]);

/**
 * Build a PSTITLEIMG-wrapped PSAR from multiple PSISOIMG sections.
 *
 * Assembles the 0x8000-byte header, concatenates all disc PSISOIMG sections
 * (each aligned to 0x8000), and appends STARTDAT at the end.
 *
 * @param {Array<Uint8Array>} psisoSections - PSISOIMG blobs (one per disc, in order)
 * @param {Object} opts
 * @param {string} opts.discId - Primary disc ID (disc 1, e.g. "SCUS94163")
 * @param {string} opts.title - Game title for the header
 * @returns {Uint8Array} Complete DATA.PSAR ready for PBP embedding
 */
export function buildPstitleimg(psisoSections, opts) {
  const numDiscs = psisoSections.length;
  if (numDiscs < 1 || numDiscs > MAX_DISCS) {
    throw new Error(`Invalid disc count: ${numDiscs} (max ${MAX_DISCS})`);
  }

  // Build header (padded to DISC_ALIGN with zeros)
  const header = new Uint8Array(DISC_ALIGN); // zero-padded
  const headerDv = new DataView(header.buffer);

  // +0x0000: Magic (16 bytes)
  for (let i = 0; i < PSTITLEIMG_MAGIC.length; i++) {
    header[i] = PSTITLEIMG_MAGIC.charCodeAt(i);
  }

  // Calculate disc offsets (relative to start of PSAR/PSTITLEIMG)
  // Sony aligns first disc to 0x8000 and all subsequent to 0x8000 boundaries
  let offset = DISC_ALIGN;
  for (let i = 0; i < numDiscs; i++) {
    headerDv.setUint32(DISC_OFFSET_TABLE_START + i * 4, offset, true);
    offset += psisoSections[i].length;
    // Align next disc to 0x8000 boundary
    offset = (offset + DISC_ALIGN - 1) & ~(DISC_ALIGN - 1);
  }
  // Zero-terminate the offset table
  if (numDiscs < MAX_DISCS) {
    headerDv.setUint32(DISC_OFFSET_TABLE_START + numDiscs * 4, 0, true);
  }

  // p1 = offset where STARTDAT starts (after all disc sections)
  const startdatOffset = offset;

  // Build STARTDAT (appended after all disc sections, same as Sony PSN EBOOTs)
  const startdatLogo = makeStartdatLogo();
  const startdatHeader = makeStartdatHeader(startdatLogo.length);
  const startdatFooter = makeStartdatFooter();
  const startdatSize = startdatHeader.length + startdatLogo.length + startdatFooter.length;
  const totalSize = startdatOffset + startdatSize;

  // +0x0010: p1_offset (points to STARTDAT)
  headerDv.setUint32(0x10, startdatOffset, true);

  // +0x0018: Hash/key constants (4 x uint32 LE, same in all known EBOOTs)
  for (let i = 0; i < 4; i++) {
    headerDv.setUint32(0x18 + i * 4, HEADER_HASH_U32[i], true);
  }

  // +0x0214: Disc size table (fixed constants from Sony EBOOTs)
  header.set(DISC_SIZE_TABLE, 0x214);

  // +0x0264: Primary disc ID in "_SCUS_94163" format (Sony puts it at +0x264, not +0x260)
  if (opts?.discId) {
    const formatted = '_' + opts.discId.slice(0, 4) + '_' + opts.discId.slice(4);
    for (let i = 0; i < formatted.length; i++) {
      header[0x264 + i] = formatted.charCodeAt(i);
    }
  }

  // +0x284: p2_offset = p1 + 0x2D31 (Sony stores at +0x284, +0x280 is zero)
  headerDv.setUint32(0x284, startdatOffset + STARTDAT_CONST, true);

  // +0x28C: Data3/crypto template (fixed constants from Sony EBOOTs)
  header.set(DATA3_CRYPTO, 0x28C);

  // +0x30C: Title string (zero-terminated)
  if (opts?.title) {
    for (let i = 0; i < opts.title.length; i++) {
      header[0x30C + i] = opts.title.charCodeAt(i);
    }
  }

  // +0x38C: 0x07 marker
  header[0x38C] = 0x07;

  // Assemble: header + all PSISOIMG sections with alignment padding + STARTDAT
  const result = new Uint8Array(totalSize); // zero-initialized (padding is automatic)
  result.set(header, 0);

  let pos = DISC_ALIGN;
  for (const section of psisoSections) {
    result.set(section, pos);
    pos += section.length;
    pos = (pos + DISC_ALIGN - 1) & ~(DISC_ALIGN - 1);
  }

  // STARTDAT at the end (p1 points here)
  pos = startdatOffset;
  result.set(startdatHeader, pos); pos += startdatHeader.length;
  result.set(startdatLogo, pos); pos += startdatLogo.length;
  result.set(startdatFooter, pos);

  return result;
}

/**
 * Build a complete DATA.PSAR from one or more disc image files.
 *
 * This is the top-level entry point for PSAR construction. For a single disc,
 * returns a bare PSISOIMG. For multiple discs, wraps them in PSTITLEIMG.
 *
 * @param {Array<File>} files - Disc image files in play order
 * @param {Object} opts
 * @param {string} opts.title         - Game title
 * @param {Array<string>} opts.discIds - Disc ID per file (e.g. ["SCUS94163", ...])
 * @param {Array<Uint8Array>} opts.tocs - TOC binary per disc
 * @param {number} [opts.compressionLevel=5] - deflate level (0–9)
 * @param {Array<Object>} [opts.preCompressed] - Pre-compressed data per disc from workers
 * @param {function} [opts.onProgress] - Progress callback(fraction, label)
 * @returns {Promise<{data: Uint8Array, discStats: Object[]}>}
 */
export async function buildPsar(files, opts) {
  const numDiscs = files.length;
  const onProgress = opts.onProgress || (() => {});
  const sectionData = [];
  const discStats = [];

  for (let d = 0; d < numDiscs; d++) {
    const discProgress = (pct, label) => {
      const overall = (d + pct) / numDiscs;
      onProgress(overall, `Disc ${d + 1}/${numDiscs}: ${label}`);
    };

    const preComp = opts.preCompressed?.[d] || undefined;
    const fileOrSize = preComp ? files[d].size : files[d];
    const result = await buildPsisoimg(fileOrSize, {
      discId: opts.discIds[d],
      title: opts.title,
      toc: opts.tocs[d],
      compressionLevel: opts.compressionLevel ?? 5,
      onProgress: discProgress,
      preCompressed: preComp,
      multiDisc: numDiscs > 1,
    });
    sectionData.push(result.data);
    discStats.push(result.stats);
  }

  // Single disc: bare PSISOIMG (no wrapper). Multi-disc: PSTITLEIMG wrapper.
  const psar = numDiscs === 1
    ? sectionData[0]
    : buildPstitleimg(sectionData, { discId: opts.discIds[0], title: opts.title });
  return { data: psar, discStats };
}
