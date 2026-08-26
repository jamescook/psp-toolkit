import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMcr, findSaveLinks, extractSaveMcr,
  MCR_SIZE, BLOCK_SIZE, HEADER_SIZE, MAX_SLOTS,
} from './helpers.js';

/** Build a synthetic 128KB card with the given bytes at slot 0's header frame
 *  (byte offset HEADER_SIZE, since frame 0 is the card ID frame, not a slot). */
function cardWithHeader(headerBytes) {
  const data = new Uint8Array(MCR_SIZE);
  data.set(headerBytes, HEADER_SIZE);
  return data;
}

/** Build a header frame: state byte + 3-byte LE size + next-slot link + 20-byte filename field. */
function buildHeader({ state, size = 0, next = 0xff, filename = '' }) {
  const header = new Uint8Array(HEADER_SIZE);
  header[0] = state;
  header[4] = size & 0xff;
  header[5] = (size >> 8) & 0xff;
  header[6] = (size >> 16) & 0xff;
  header[8] = next;
  for (let i = 0; i < filename.length && i < 20; i++) {
    header[0x0a + i] = filename.charCodeAt(i);
  }
  return header;
}

/** Write a header frame + optional data block at the given slot index. */
function setSlot(data, slot, header, blockByte) {
  data.set(header, HEADER_SIZE * (slot + 1));
  if (blockByte !== undefined) {
    data.fill(blockByte, BLOCK_SIZE * (slot + 1), BLOCK_SIZE * (slot + 2));
  }
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

  it('parses each of the 15 slots independently at their own frame, offset by the card ID frame', () => {
    const data = new Uint8Array(MCR_SIZE);
    setSlot(data, 0, buildHeader({ state: 0x51, filename: 'SLOT0' }));
    setSlot(data, 1, buildHeader({ state: 0xa0 }));
    setSlot(data, 14, buildHeader({ state: 0x51, filename: 'SLOT14' }));
    const slots = parseMcr(data);
    assert.equal(slots[0].type, 'initial');
    assert.equal(slots[0].region, 'SL');
    assert.equal(slots[1].type, 'formatted');
    assert.equal(slots[14].type, 'initial');
    assert.equal(slots[14].region, 'SL');
  });

  it("does not read the card ID frame (byte offset 0) as slot 0's header", () => {
    const data = new Uint8Array(MCR_SIZE);
    data[0] = 0x4d; // 'M' of the "MC" card ID signature -- not a valid BLOCK_TYPES state
    data[1] = 0x43; // 'C'
    const [slot0] = parseMcr(data);
    assert.equal(slot0.type, 'corrupted'); // slot 0 (frame 1) is untouched/zeroed, not the ID frame
  });
});

describe('findSaveLinks', () => {
  it('returns just the starting slot when its link byte is 0xFF (single-block save)', () => {
    const data = new Uint8Array(MCR_SIZE);
    setSlot(data, 3, buildHeader({ state: 0x51, next: 0xff }));
    assert.deepEqual(findSaveLinks(data, 3), [3]);
  });

  it('follows a multi-block chain: initial -> middle-link -> end-link', () => {
    const data = new Uint8Array(MCR_SIZE);
    setSlot(data, 0, buildHeader({ state: 0x51, next: 1 }));
    setSlot(data, 1, buildHeader({ state: 0x52, next: 2 }));
    setSlot(data, 2, buildHeader({ state: 0x53, next: 0xff }));
    assert.deepEqual(findSaveLinks(data, 0), [0, 1, 2]);
  });

  it('stops at a corrupted frame (but still includes it)', () => {
    const data = new Uint8Array(MCR_SIZE);
    setSlot(data, 0, buildHeader({ state: 0x51, next: 1 }));
    setSlot(data, 1, buildHeader({ state: 0x00, next: 2 })); // corrupted
    setSlot(data, 2, buildHeader({ state: 0x53, next: 0xff }));
    assert.deepEqual(findSaveLinks(data, 0), [0, 1]);
  });

  it('stops at an out-of-range link byte instead of following garbage', () => {
    const data = new Uint8Array(MCR_SIZE);
    setSlot(data, 0, buildHeader({ state: 0x51, next: 200 }));
    assert.deepEqual(findSaveLinks(data, 0), [0]);
  });

  it('is capped at MAX_SLOTS iterations against a cyclic chain', () => {
    const data = new Uint8Array(MCR_SIZE);
    // Every slot points to the next, wrapping back to 0 -- a malformed cycle.
    for (let i = 0; i < MAX_SLOTS; i++) {
      setSlot(data, i, buildHeader({ state: i === 0 ? 0x51 : 0x52, next: (i + 1) % MAX_SLOTS }));
    }
    const chain = findSaveLinks(data, 0);
    assert.equal(chain.length, MAX_SLOTS);
  });
});

describe('extractSaveMcr', () => {
  it('throws on wrong-length input', () => {
    assert.throws(() => extractSaveMcr(new Uint8Array(100), 0), /131072/);
  });

  it('returns exactly MCR_SIZE bytes', () => {
    const data = new Uint8Array(MCR_SIZE);
    setSlot(data, 0, buildHeader({ state: 0x51 }));
    assert.equal(extractSaveMcr(data, 0).length, MCR_SIZE);
  });

  it('preserves the card ID frame and the selected save\'s header + data verbatim', () => {
    const data = new Uint8Array(MCR_SIZE);
    data[0] = 0x4d; data[1] = 0x43; // "MC" card ID signature
    setSlot(data, 5, buildHeader({ state: 0x51, filename: 'BASLUS-00594' }), 0xAB);

    const out = extractSaveMcr(data, 5);
    assert.equal(out[0], 0x4d);
    assert.equal(out[1], 0x43);
    const [, , , , , slot5] = parseMcr(out);
    assert.equal(slot5.type, 'initial');
    assert.equal(slot5.productCode, 'SLUS-00594');
    assert.ok(out.subarray(BLOCK_SIZE * 6, BLOCK_SIZE * 7).every(b => b === 0xAB));
  });

  it('blanks every slot outside the save chain (formatted, zeroed data)', () => {
    const data = new Uint8Array(MCR_SIZE);
    setSlot(data, 0, buildHeader({ state: 0x51 }));
    setSlot(data, 7, buildHeader({ state: 0x51, filename: 'OTHERGAME' }), 0xCD);

    const out = extractSaveMcr(data, 0);
    const slots = parseMcr(out);
    assert.equal(slots[7].type, 'formatted');
    assert.ok(out.subarray(BLOCK_SIZE * 8, BLOCK_SIZE * 9).every(b => b === 0));
  });

  it('preserves every block of a multi-block chain', () => {
    const data = new Uint8Array(MCR_SIZE);
    setSlot(data, 0, buildHeader({ state: 0x51, next: 1 }), 0x11);
    setSlot(data, 1, buildHeader({ state: 0x53, next: 0xff }), 0x22);

    const out = extractSaveMcr(data, 0);
    assert.ok(out.subarray(BLOCK_SIZE * 1, BLOCK_SIZE * 2).every(b => b === 0x11));
    assert.ok(out.subarray(BLOCK_SIZE * 2, BLOCK_SIZE * 3).every(b => b === 0x22));
  });
});
