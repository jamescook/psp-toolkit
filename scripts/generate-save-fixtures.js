#!/usr/bin/env node
// Generate the synthetic .gme fixture used by test/e2e/save-manager.spec.js.
//
// A deterministic, safe-to-commit memory card with two real saves (no real
// game/hardware data): one single-block save and one two-block chain, each
// with a distinct, recognizable product code so the E2E spec can assert on
// filenames and slot content without depending on a real .gme file.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

async function main() {
  const { MCR_SIZE, HEADER_SIZE, BLOCK_SIZE } = await import(path.join(ROOT, 'save', 'mcr.js'));
  const { GME_HEADER_SIZE, GME_MAGIC } = await import(path.join(ROOT, 'save', 'gme.js'));

  const mcr = new Uint8Array(MCR_SIZE);
  mcr[0] = 0x4d; mcr[1] = 0x43; // "MC" card ID signature (frame 0, not a save slot)

  function writeHeader(slot, { state, size = 0, next = 0xff, region, productCode, identifier }) {
    const off = HEADER_SIZE * (slot + 1);
    mcr[off] = state;
    mcr[off + 4] = size & 0xff;
    mcr[off + 5] = (size >> 8) & 0xff;
    mcr[off + 6] = (size >> 16) & 0xff;
    mcr[off + 8] = next;
    const name = region + productCode + identifier;
    for (let i = 0; i < name.length; i++) mcr[off + 0x0a + i] = name.charCodeAt(i);
  }

  function fillDataBlock(slot, byte) {
    const off = BLOCK_SIZE * (slot + 1);
    mcr.fill(byte, off, off + BLOCK_SIZE);
  }

  // Slot 0: single-block save.
  writeHeader(0, { state: 0x51, size: BLOCK_SIZE, next: 0xff, region: 'BA', productCode: 'SLUS-99999', identifier: 'TESTSAVE' });
  fillDataBlock(0, 0x11);

  // Slot 1 -> 2: two-block chain (initial -> end-link).
  writeHeader(1, { state: 0x51, size: BLOCK_SIZE * 2, next: 2, region: 'BE', productCode: 'SCUS-88888', identifier: 'MULTIBLK' });
  fillDataBlock(1, 0x22);
  writeHeader(2, { state: 0x53, next: 0xff, region: '', productCode: '', identifier: '' });
  fillDataBlock(2, 0x33);

  // Every other slot stays formatted/empty (all zero -- parseMcr defaults to
  // 'corrupted' for an all-zero header, so mark them 'formatted' explicitly
  // like apollo-psp's formatSlot() does).
  for (let slot = 3; slot < 15; slot++) {
    writeHeader(slot, { state: 0xa0, next: 0xff, region: '', productCode: '', identifier: '' });
  }

  const gme = new Uint8Array(GME_HEADER_SIZE + MCR_SIZE);
  for (let i = 0; i < GME_MAGIC.length; i++) gme[i] = GME_MAGIC.charCodeAt(i);
  gme.set(mcr, GME_HEADER_SIZE);

  fs.mkdirSync(FIXTURES, { recursive: true });
  const outPath = path.join(FIXTURES, 'save-test.gme');
  fs.writeFileSync(outPath, Buffer.from(gme));
  console.log(`Wrote ${outPath} (${gme.length} bytes)`);
}

main();
