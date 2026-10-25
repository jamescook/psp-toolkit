import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectDiscId, isRawImage } from './helpers.js';
import { MockFile } from './helpers.js';
import { createMockPS1Disc, createMockPSPDisc, createMultiTrackDisc } from './fixtures.js';

describe('isRawImage', () => {
  it('detects raw 2352-byte sector images by sync pattern', async () => {
    const disc = createMockPS1Disc({ discId: 'SLUS00001' });
    const file = new MockFile(disc, 'test.bin');
    assert.equal(await isRawImage(file), true);
  });

  it('rejects non-raw images', async () => {
    const data = new Uint8Array(2048 * 20);
    const file = new MockFile(data, 'test.iso');
    assert.equal(await isRawImage(file), false);
  });
});

describe('detectDiscId', () => {
  it('extracts disc ID from a raw PS1 disc image', async () => {
    const disc = createMockPS1Disc({ discId: 'SLUS00896' });
    const file = new MockFile(disc, 'test.bin');
    const result = await detectDiscId(file);
    assert.ok(result);
    assert.equal(result.discId, 'SLUS00896');
    assert.equal(result.bootFile, 'SLUS_008.96');
  });

  it('extracts title from PVD volume ID', async () => {
    const disc = createMockPS1Disc({ discId: 'SCUS94163', volumeId: 'FF7DISC1' });
    const file = new MockFile(disc, 'test.bin');
    const result = await detectDiscId(file);
    assert.ok(result);
    assert.equal(result.title, 'Ff7Disc1');
  });

  it('title-cases volume IDs with underscores', async () => {
    const disc = createMockPS1Disc({ discId: 'SLUS00896', volumeId: 'TRON_BONNE' });
    const file = new MockFile(disc, 'test.bin');
    const result = await detectDiscId(file);
    assert.ok(result);
    assert.equal(result.title, 'Tron Bonne');
  });

  it('works with multi-track disc (track 1 only)', async () => {
    const mt = createMultiTrackDisc({ discId: 'SLUS00896', volumeId: 'TRON_BONNE' });
    const file = new MockFile(mt.track1, mt.track1Name);
    const result = await detectDiscId(file);
    assert.ok(result);
    assert.equal(result.discId, 'SLUS00896');
    assert.equal(result.title, 'Tron Bonne');
  });

  it('reads a PSP disc ID from UMD_DATA.BIN', async () => {
    const disc = createMockPSPDisc({ serial: 'ULUS-10277', volumeId: 'TEST_PSP' });
    const result = await detectDiscId(new MockFile(disc, 'game.iso'));
    assert.ok(result);
    assert.equal(result.discId, 'ULUS10277');
    assert.equal(result.title, 'Test Psp');
  });

  it('returns null for non-PS1 data', async () => {
    const data = new Uint8Array(2352 * 20);
    const file = new MockFile(data, 'garbage.bin');
    const result = await detectDiscId(file);
    assert.equal(result, null);
  });
});
