// Save Manager Web Worker — isolates a single save off the main thread and
// packages it into the requested output format; also verifies a VMP's
// signature for the Diagnose tab inspector.
//
// Message protocol:
//   IN:  { mcr: ArrayBuffer, slotIndex: number, format?: 'vmp'|'mcr'|'gme' }
//        (mcr is the full, already-unwrapped 128KB raw memory card; format
//        defaults to 'vmp')
//   OUT: { type: 'progress', pct: 0-100, label: string }
//   OUT: { type: 'done', result: ArrayBuffer }  (.vmp/.mcr/.gme bytes)
//   OUT: { type: 'error', message: string }
//
//   IN:  { action: 'verifyVmp', vmp: ArrayBuffer }  (a complete .vmp file)
//   OUT: { type: 'done', result: { valid: boolean, stored: string, expected: string } }
//        (stored/expected are lowercase hex signatures)
//   OUT: { type: 'error', message: string }
//
// One worker instance handles one slot; the UI spins up several in parallel
// for a multi-slot extraction, mirroring patch-worker.js's per-item pattern.
// The signature check is dispatched here (rather than run inline in
// diagnose.js) because it needs AES-128-ECB, which has no native browser API
// (see save/aes-ecb.js) -- routing through the worker reuses that single
// implementation instead of duplicating it in the UI thread.

import { extractSaveMcr } from './save/mcr.js';
import { buildVmp, generateHash, VMP_SIZE, VMP_SEED_OFFSET, VMP_HASH_OFFSET } from './save/vmp.js';
import { wrapGme } from './save/gme.js';

function progress(pct, label) {
  self.postMessage({ type: 'progress', pct, label });
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyVmp(vmpBuffer) {
  const vmp = new Uint8Array(vmpBuffer);
  if (vmp.length !== VMP_SIZE) {
    throw new Error(`Expected a ${VMP_SIZE}-byte VMP file, got ${vmp.length}`);
  }

  const stored = vmp.slice(VMP_HASH_OFFSET, VMP_HASH_OFFSET + 20);

  // Recompute on a copy with the hash field zeroed, mirroring buildVmp()'s
  // own self-consistency check in test/vmp.test.js.
  const recomputeInput = vmp.slice();
  recomputeInput.fill(0, VMP_HASH_OFFSET, VMP_HASH_OFFSET + 20);
  const seed = recomputeInput.subarray(VMP_SEED_OFFSET, VMP_SEED_OFFSET + 20);
  const expected = await generateHash(recomputeInput, seed, VMP_SIZE);

  const valid = stored.length === expected.length && stored.every((b, i) => b === expected[i]);
  return { valid, stored: toHex(stored), expected: toHex(expected) };
}

self.onmessage = async function(e) {
  try {
    if (e.data.action === 'verifyVmp') {
      const result = await verifyVmp(e.data.vmp);
      self.postMessage({ type: 'done', result });
      return;
    }

    const { mcr, slotIndex, format = 'vmp' } = e.data;

    progress(20, 'Isolating save...');
    const singleSaveMcr = extractSaveMcr(new Uint8Array(mcr), slotIndex);

    let result;
    if (format === 'mcr') {
      result = singleSaveMcr;
    } else if (format === 'gme') {
      progress(60, 'Wrapping GME...');
      result = wrapGme(singleSaveMcr);
    } else {
      progress(60, 'Signing VMP...');
      result = await buildVmp(singleSaveMcr);
    }

    progress(100, 'Done');
    self.postMessage({ type: 'done', result: result.buffer }, [result.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
