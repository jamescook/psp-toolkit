import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripGmeHeader, GME_HEADER_SIZE, GME_SIZE, GME_MAGIC, MCR_SIZE, parseMcr } from './helpers.js';

/** Build a synthetic .gme: real magic + arbitrary header filler + a distinctive card payload. */
function buildGme({ magic = GME_MAGIC, cardByte = 0xab } = {}) {
  const data = new Uint8Array(GME_SIZE);
  for (let i = 0; i < magic.length; i++) data[i] = magic.charCodeAt(i);
  data.fill(cardByte, GME_HEADER_SIZE);
  return data;
}

describe('stripGmeHeader', () => {
  it('returns exactly the 131072-byte card payload', () => {
    const data = buildGme();
    const card = stripGmeHeader(data);
    assert.equal(card.length, MCR_SIZE);
  });

  it('strips exactly 3904 header bytes -- payload is byte-identical to what follows', () => {
    const data = buildGme({ cardByte: 0xcd });
    const card = stripGmeHeader(data);
    assert.equal(card[0], 0xcd);
    assert.equal(card[MCR_SIZE - 1], 0xcd);
    // Confirm it's a view/slice starting exactly at the header boundary, not off-by-one.
    assert.equal(data[GME_HEADER_SIZE - 1] === 0xcd, false); // last header byte untouched
    assert.equal(data[GME_HEADER_SIZE], 0xcd); // first card byte
  });

  it('the stripped payload feeds directly into parseMcr without error', () => {
    const data = buildGme();
    assert.doesNotThrow(() => parseMcr(stripGmeHeader(data)));
  });

  it('rejects a file of the wrong total size', () => {
    const tooShort = buildGme().subarray(0, GME_SIZE - 1);
    assert.throws(() => stripGmeHeader(tooShort), /134976/);
  });

  it('rejects a correctly-sized file with the wrong magic', () => {
    const data = buildGme({ magic: 'not-a-dexdrive-header' });
    assert.throws(() => stripGmeHeader(data), /magic/);
  });
});
