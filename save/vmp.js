// VMP writer — POPS/PSP save format
//
// A .vmp file is a 0x80-byte header wrapped around a verbatim 128KB raw PS1
// memory card, plus a 20-byte SHA1-based signature. Ported from
// bucanero/apollo-psp's ps1card.c (setVmpCardHeader — the unsigned header
// layout) and vmp_resign.c (generateHash — the signing scheme), itself based
// on dots-tb/vita-mcr2vmp. The signing key and IV below are fixed, public
// constants embedded in that (GPL) source — not secret key material.

import { aes128EncryptBlock, aes128DecryptBlock } from './aes-ecb.js';
import { MCR_SIZE } from './mcr.js';

// setVmpCardHeader: byte 0 is left zero, bytes 1-3 spell "PMV" (the magic,
// read as a little-endian uint32 at offset 0 it's 0x564D5000), byte 4 is a
// header-length marker (0x80) -- easy to miss since it's not part of the
// magic-number comparison in vmp_resign.c, only written when building fresh.
export const VMP_HEADER_BYTES = new Uint8Array([0x00, 0x50, 0x4d, 0x56, 0x80]);
export const MCR_OFFSET = 0x80;
export const VMP_SEED_OFFSET = 0x0c;
export const VMP_HASH_OFFSET = 0x20;
export const VMP_SIZE = MCR_OFFSET + MCR_SIZE; // 0x20080

const SEED_STRING = new TextEncoder().encode('www.bucanero.com.ar\0'); // 20 bytes incl. trailing NUL

const VMP_PS1_KEY = new Uint8Array([
  0xab, 0x5a, 0xbc, 0x9f, 0xc1, 0xf4, 0x9d, 0xe6, 0xa0, 0x51, 0xdb, 0xae, 0xfa, 0x51, 0x88, 0x59,
]);
const VMP_IV = new Uint8Array([
  0xb3, 0x0f, 0xfe, 0xed, 0xb7, 0xdc, 0x5e, 0xb7, 0x13, 0x3d, 0xa6, 0x0d, 0x1b, 0x6b, 0x2c, 0xdc,
]);

function xorInPlace(buf, off, other, len) {
  for (let i = 0; i < len; i++) buf[off + i] ^= other[i];
}

function xorByteInPlace(buf, off, len, byte) {
  for (let i = 0; i < len; i++) buf[off + i] ^= byte;
}

async function sha1(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const combined = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { combined.set(p, pos); pos += p.length; }
  const digest = await crypto.subtle.digest('SHA-1', combined);
  return new Uint8Array(digest);
}

/**
 * Compute the 20-byte VMP/PSV signature, mirroring vmp_resign.c's generateHash().
 *
 * As a side effect, overwrites `seed` (20 bytes) with the fixed seed string —
 * mirrors the C function's `memcpy(salt_seed, "www.bucanero.com.ar", 20)`.
 * When `seed` is a view into the same buffer as `input`, that write is visible
 * to the hash pass below it, exactly as in the original pointer-aliased C code.
 *
 * @param {Uint8Array} input - data to hash (first `sz` bytes)
 * @param {Uint8Array} seed - 20-byte seed buffer; overwritten in place
 * @param {number} sz - number of bytes of `input` to hash
 * @returns {Promise<Uint8Array>} 20-byte signature
 */
export async function generateHash(input, seed, sz) {
  seed.set(SEED_STRING);

  const salt = new Uint8Array(64);
  const work0 = seed.subarray(0, 16); // "www.bucanero.com"
  salt.set(aes128DecryptBlock(work0, VMP_PS1_KEY), 0);
  salt.set(aes128EncryptBlock(work0, VMP_PS1_KEY), 16);
  xorInPlace(salt, 0, VMP_IV, 16);

  const work1 = new Uint8Array(16).fill(0xff);
  work1.set(seed.subarray(16, 20), 0);
  xorInPlace(salt, 16, work1, 16);

  salt.fill(0, 20, 64);

  xorByteInPlace(salt, 0, 64, 0x36);
  const inner = await sha1(salt, input.subarray(0, sz));

  xorByteInPlace(salt, 0, 64, 0x6a); // applied directly to the already-0x36-XORed salt, matching the C's sequential XorWithByte calls
  return sha1(salt, inner);
}

/**
 * Extract the raw 128KB PS1 memory card payload from a .vmp file.
 *
 * No signature verification -- a .vmp read back from POPS/PSP hardware was
 * already trusted when it was written; this is purely for exporting it to a
 * PC emulator, which just wants the raw card.
 *
 * @param {Uint8Array} vmp - a complete VMP_SIZE-byte .vmp file
 * @returns {Uint8Array} raw memory card, exactly MCR_SIZE bytes
 */
export function extractMcr(vmp) {
  if (vmp.length !== VMP_SIZE) {
    throw new Error(`Expected a ${VMP_SIZE}-byte VMP file, got ${vmp.length}`);
  }
  return vmp.slice(MCR_OFFSET, MCR_OFFSET + MCR_SIZE);
}

/**
 * Build a complete .vmp file from a raw 128KB PS1 memory card.
 * @param {Uint8Array} mcr - raw memory card, exactly MCR_SIZE bytes
 * @returns {Promise<Uint8Array>} complete VMP_SIZE-byte .vmp file
 */
export async function buildVmp(mcr) {
  if (mcr.length !== MCR_SIZE) {
    throw new Error(`Expected a ${MCR_SIZE}-byte memory card, got ${mcr.length}`);
  }

  const out = new Uint8Array(VMP_SIZE);
  out.set(VMP_HEADER_BYTES, 0);
  out.set(mcr, MCR_OFFSET);

  const seed = out.subarray(VMP_SEED_OFFSET, VMP_SEED_OFFSET + 20);
  const signature = await generateHash(out, seed, VMP_SIZE);
  out.set(signature, VMP_HASH_OFFSET);

  return out;
}
