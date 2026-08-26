// Save Manager Web Worker — builds a single-save VMP off the main thread
//
// Message protocol:
//   IN:  { mcr: ArrayBuffer, slotIndex: number }  (mcr is the full, already
//        GME-header-stripped 128KB raw memory card)
//   OUT: { type: 'progress', pct: 0-100, label: string }
//   OUT: { type: 'done', result: ArrayBuffer }       (a complete .vmp file)
//   OUT: { type: 'error', message: string }
//
// One worker instance handles one slot; the UI spins up several in parallel
// for a multi-slot extraction, mirroring patch-worker.js's per-item pattern.

import { extractSaveMcr } from './save/mcr.js';
import { buildVmp } from './save/vmp.js';

function progress(pct, label) {
  self.postMessage({ type: 'progress', pct, label });
}

self.onmessage = async function(e) {
  try {
    const { mcr, slotIndex } = e.data;

    progress(20, 'Isolating save...');
    const singleSaveMcr = extractSaveMcr(new Uint8Array(mcr), slotIndex);

    progress(60, 'Signing VMP...');
    const vmp = await buildVmp(singleSaveMcr);

    progress(100, 'Done');
    self.postMessage({ type: 'done', result: vmp.buffer }, [vmp.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
