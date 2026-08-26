import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripGmeHeader, wrapGme,
  GME_HEADER_SIZE, GME_SIZE, GME_MAGIC, MCR_SIZE, HEADER_SIZE, MAX_SLOTS,
  parseMcr,
} from './helpers.js';

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

/** Build a synthetic 128KB card with a couple of occupied slots. */
function buildMcr() {
  const mcr = new Uint8Array(MCR_SIZE);
  function setSlot(slot, state, next) {
    const off = HEADER_SIZE * (slot + 1);
    mcr[off] = state;
    mcr[off + 8] = next;
  }
  setSlot(0, 0x51, 0xff); // single-block save
  setSlot(1, 0x51, 2);    // two-block chain
  setSlot(2, 0x53, 0xff);
  for (let slot = 3; slot < MAX_SLOTS; slot++) setSlot(slot, 0xa0, 0xff);
  return mcr;
}

describe('wrapGme', () => {
  it('throws on wrong-length input', () => {
    assert.throws(() => wrapGme(new Uint8Array(100)), /131072/);
  });

  it('produces exactly GME_SIZE bytes with the DexDrive magic at offset 0', () => {
    const out = wrapGme(new Uint8Array(MCR_SIZE));
    assert.equal(out.length, GME_SIZE);
    const magic = String.fromCharCode(...out.subarray(0, GME_MAGIC.length));
    assert.equal(magic, GME_MAGIC);
  });

  it('sets the fixed flag bytes apollo-psp always writes (18, 20, 21)', () => {
    const out = wrapGme(new Uint8Array(MCR_SIZE));
    assert.equal(out[18], 0x01);
    assert.equal(out[20], 0x01);
    assert.equal(out[21], 0x4d); // 'M'
  });

  it("copies each slot's block-state and next-link bytes into the header's per-slot arrays", () => {
    const mcr = buildMcr();
    const out = wrapGme(mcr);
    assert.deepEqual([...out.subarray(22, 22 + MAX_SLOTS)], [0x51, 0x51, 0x53, ...Array(12).fill(0xa0)]);
    assert.deepEqual([...out.subarray(38, 38 + MAX_SLOTS)], [0xff, 2, 0xff, ...Array(12).fill(0xff)]);
  });

  it('leaves the per-slot comment fields zeroed', () => {
    const out = wrapGme(buildMcr());
    assert.ok(out.subarray(64, GME_HEADER_SIZE).every(b => b === 0));
  });

  it('embeds the card payload verbatim, byte-identical to the input', () => {
    const mcr = buildMcr();
    const out = wrapGme(mcr);
    assert.deepEqual([...out.subarray(GME_HEADER_SIZE)], [...mcr]);
  });

  it('round-trips through stripGmeHeader back to the original card', () => {
    const mcr = buildMcr();
    const out = wrapGme(mcr);
    assert.deepEqual([...stripGmeHeader(out)], [...mcr]);
  });

  it("round-trips through parseMcr with a slot list matching the pre-wrap source", () => {
    const mcr = buildMcr();
    const before = parseMcr(mcr);
    const after = parseMcr(stripGmeHeader(wrapGme(mcr)));
    assert.deepEqual(after, before);
  });
});
