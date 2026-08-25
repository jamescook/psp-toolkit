import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcr, MCR_SIZE, HEADER_SIZE, MAX_SLOTS } from './helpers.js';

/** Build a synthetic 128KB card with the given bytes at slot 0's header frame. */
function cardWithHeader(headerBytes) {
  const data = new Uint8Array(MCR_SIZE);
  data.set(headerBytes, 0);
  return data;
}

/** Build a slot-0 header frame: state byte + 3-byte LE size + 20-byte filename field. */
function buildHeader({ state, size = 0, filename = '' }) {
  const header = new Uint8Array(HEADER_SIZE);
  header[0] = state;
  header[4] = size & 0xff;
  header[5] = (size >> 8) & 0xff;
  header[6] = (size >> 16) & 0xff;
  for (let i = 0; i < filename.length && i < 20; i++) {
    header[0x0a + i] = filename.charCodeAt(i);
  }
  return header;
}

describe('parseMcr', () => {
  it('throws on wrong-length input', () => {
    assert.throws(() => parseMcr(new Uint8Array(100)), /131072/);
  });

  it('returns exactly 15 slots', () => {
    const slots = parseMcr(new Uint8Array(MCR_SIZE));
    assert.equal(slots.length, MAX_SLOTS);
  });

  const BLOCK_TYPE_CASES = [
    [0xa0, 'formatted'],
    [0x51, 'initial'],
    [0x52, 'middle-link'],
    [0x53, 'end-link'],
    [0xa1, 'deleted-initial'],
    [0xa2, 'deleted-middle-link'],
    [0xa3, 'deleted-end-link'],
    [0x00, 'corrupted'],
    [0xff, 'corrupted'],
  ];

  for (const [byte, expectedType] of BLOCK_TYPE_CASES) {
    it(`decodes state byte 0x${byte.toString(16)} as '${expectedType}'`, () => {
      const data = cardWithHeader(buildHeader({ state: byte }));
      const [slot0] = parseMcr(data);
      assert.equal(slot0.type, expectedType);
    });
  }

  it('parses a 3-byte little-endian size', () => {
    // 0x020000 = 131072 bytes = a 16-block save
    const data = cardWithHeader(buildHeader({ state: 0x51, size: 0x020000 }));
    const [slot0] = parseMcr(data);
    assert.equal(slot0.size, 0x020000);
  });

  it('splits the 20-byte filename field into region/productCode/identifier/name', () => {
    // Real-world example shape: 2-char region + 10-char product code + 8-char suffix
    const data = cardWithHeader(buildHeader({ state: 0x51, filename: 'BASLUS-00594wonderful' }));
    const [slot0] = parseMcr(data);
    assert.equal(slot0.region, 'BA');
    assert.equal(slot0.productCode, 'SLUS-00594');
    assert.equal(slot0.identifier, 'wonderfu'); // 8 bytes — 'l' falls outside the field
    assert.equal(slot0.name, 'BASLUS-00594wonderfu'); // 20 bytes total
  });

  it('stops filename fields at the first null byte', () => {
    const data = cardWithHeader(buildHeader({ state: 0x51, filename: 'BASLUS-00001' }));
    const [slot0] = parseMcr(data);
    assert.equal(slot0.productCode, 'SLUS-00001');
    assert.equal(slot0.identifier, '');
  });

  it('parses each of the 15 slots independently at their own 128-byte offset', () => {
    const data = new Uint8Array(MCR_SIZE);
    data.set(buildHeader({ state: 0x51, filename: 'SLOT0' }), 0 * HEADER_SIZE);
    data.set(buildHeader({ state: 0xa0 }), 1 * HEADER_SIZE);
    data.set(buildHeader({ state: 0x51, filename: 'SLOT14' }), 14 * HEADER_SIZE);
    const slots = parseMcr(data);
    assert.equal(slots[0].type, 'initial');
    assert.equal(slots[0].region, 'SL');
    assert.equal(slots[1].type, 'formatted');
    assert.equal(slots[14].type, 'initial');
    assert.equal(slots[14].region, 'SL');
  });
});
