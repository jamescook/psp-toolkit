// AES-128 single-block ECB encrypt/decrypt
//
// Why this exists instead of using the platform's crypto: the VMP/PSV save
// signing scheme (ported in vmp.js) explicitly uses raw AES-128-ECB as a
// keyed block permutation, but the browser's Web Crypto (SubtleCrypto) API
// doesn't support ECB mode at all -- it was deliberately left out because
// ECB leaks patterns across multi-block messages, so there's no way to ask
// for it. The nearest substitute, AES-CBC with a zero IV over one block, is
// mathematically identical to ECB for that block, but SubtleCrypto's CBC
// always adds PKCS7 padding with no way to turn it off, so even that doesn't
// give a clean 16-byte-in/16-byte-out result.
//
// Clean-room implementation (FIPS-197) of just the single 16-byte-block
// primitive this format needs -- not general-purpose AES: no padding, no
// chaining mode, no key sizes beyond 128-bit. Same precedent as this
// project's hand-rolled LZ4 and XZ/LZMA2 decoder: filling a real gap in
// what the browser platform provides, not reaching for a dependency.

const SBOX = buildSbox();
const INV_SBOX = buildInvSbox(SBOX);
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function buildSbox() {
  // Standard AES S-box (FIPS-197 Figure 7) as a static table -- it's a fixed
  // constant, not something that benefits from being derived at runtime.
  return new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
  ]);
}

function buildInvSbox(sbox) {
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i++) inv[sbox[i]] = i;
  return inv;
}

function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

/** Expand a 16-byte AES-128 key into 11 round keys (44 32-bit words), as bytes. */
function expandKey(key) {
  const w = new Uint8Array(176); // 11 rounds * 16 bytes
  w.set(key, 0);
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      const rot0 = t1, rot1 = t2, rot2 = t3, rot3 = t0;
      t0 = SBOX[rot0] ^ RCON[i / 16 - 1];
      t1 = SBOX[rot1];
      t2 = SBOX[rot2];
      t3 = SBOX[rot3];
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function addRoundKey(state, roundKeys, round) {
  const off = round * 16;
  for (let i = 0; i < 16; i++) state[i] ^= roundKeys[off + i];
}

function subBytes(state) {
  for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
}
function invSubBytes(state) {
  for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]];
}

// State is column-major: state[c*4+r] is row r, column c.
function shiftRows(state) {
  const s = state.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      state[c * 4 + r] = s[((c + r) % 4) * 4 + r];
    }
  }
}
function invShiftRows(state) {
  const s = state.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      state[c * 4 + r] = s[((c - r + 4) % 4) * 4 + r];
    }
  }
}

function mixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const off = c * 4;
    const a0 = state[off], a1 = state[off + 1], a2 = state[off + 2], a3 = state[off + 3];
    state[off]     = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    state[off + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    state[off + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    state[off + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}
function invMixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const off = c * 4;
    const a0 = state[off], a1 = state[off + 1], a2 = state[off + 2], a3 = state[off + 3];
    state[off]     = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    state[off + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    state[off + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    state[off + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

/**
 * Encrypt exactly one 16-byte block with a 16-byte AES-128 key.
 * @param {Uint8Array} block - 16 bytes, plaintext (not mutated)
 * @param {Uint8Array} key - 16 bytes
 * @returns {Uint8Array} 16-byte ciphertext
 */
export function aes128EncryptBlock(block, key) {
  const roundKeys = expandKey(key);
  const state = block.slice();
  addRoundKey(state, roundKeys, 0);
  for (let round = 1; round <= 9; round++) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, roundKeys, round);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, roundKeys, 10);
  return state;
}

/**
 * Decrypt exactly one 16-byte block with a 16-byte AES-128 key.
 * @param {Uint8Array} block - 16 bytes, ciphertext (not mutated)
 * @param {Uint8Array} key - 16 bytes
 * @returns {Uint8Array} 16-byte plaintext
 */
export function aes128DecryptBlock(block, key) {
  const roundKeys = expandKey(key);
  const state = block.slice();
  addRoundKey(state, roundKeys, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(state);
    invSubBytes(state);
    addRoundKey(state, roundKeys, round);
    invMixColumns(state);
  }
  invShiftRows(state);
  invSubBytes(state);
  addRoundKey(state, roundKeys, 0);
  return state;
}
