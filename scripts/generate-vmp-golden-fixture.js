#!/usr/bin/env node
// Generate the committed VMP golden fixture used by test/vmp.test.js.
//
// The fixture pair (test/fixtures/vmp-golden-mcr.bin -> vmp-golden.vmp) is a
// synthetic, deterministic 128KB "memory card" run through buildVmp() --
// no real save data, so it's safe to commit (unlike a real hardware/GME
// save). To (re)confirm it's actually correct, independently verify it
// against apollo-psp's real vmp_resign.c:
//
//   node scripts/verify-vmp-oracle.cjs --oracle <apollo-psp checkout> --mcr test/fixtures/vmp-golden-mcr.bin
//
// This script only regenerates the fixture files; it does not itself invoke
// the oracle (that requires a C toolchain + mbedtls that CI/contributors
// running `npm test` shouldn't need).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function main() {
  const { MCR_SIZE } = await import(path.join(ROOT, 'save', 'mcr.js'));
  const { buildVmp } = await import(path.join(ROOT, 'save', 'vmp.js'));

  const mcr = new Uint8Array(MCR_SIZE);
  const rng = mulberry32(424242);
  for (let i = 0; i < mcr.length; i++) mcr[i] = Math.floor(rng() * 256);

  const vmp = await buildVmp(mcr);

  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'vmp-golden-mcr.bin'), Buffer.from(mcr));
  fs.writeFileSync(path.join(FIXTURES, 'vmp-golden.vmp'), Buffer.from(vmp));

  console.log(`Wrote test/fixtures/vmp-golden-mcr.bin (${mcr.length} bytes) and vmp-golden.vmp (${vmp.length} bytes).`);
  console.log('Verify against the real oracle with:');
  console.log('  node scripts/verify-vmp-oracle.cjs --oracle <apollo-psp checkout> --mcr test/fixtures/vmp-golden-mcr.bin');
}

main();
