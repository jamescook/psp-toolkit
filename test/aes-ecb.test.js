import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aes128EncryptBlock, aes128DecryptBlock } from './helpers.js';

const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

describe('aes128EncryptBlock / aes128DecryptBlock', () => {
  // FIPS-197 Appendix B known-answer vector.
  const key = fromHex('000102030405060708090a0b0c0d0e0f');
  const plaintext = fromHex('00112233445566778899aabbccddeeff');
  const ciphertext = fromHex('69c4e0d86a7b0430d8cdb78070b4c55a');

  it('matches the FIPS-197 known-answer encryption vector', () => {
    assert.equal(hex(aes128EncryptBlock(plaintext, key)), hex(ciphertext));
  });

  it('matches the FIPS-197 known-answer decryption vector', () => {
    assert.equal(hex(aes128DecryptBlock(ciphertext, key)), hex(plaintext));
  });

  it('round-trips arbitrary blocks', () => {
    const block = fromHex('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    const roundtrip = aes128DecryptBlock(aes128EncryptBlock(block, key), key);
    assert.equal(hex(roundtrip), hex(block));
  });

  it('does not mutate its input block', () => {
    const block = fromHex('00112233445566778899aabbccddeeff');
    const original = hex(block);
    aes128EncryptBlock(block, key);
    assert.equal(hex(block), original);
  });
});
