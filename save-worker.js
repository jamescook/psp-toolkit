// Save Manager Web Worker — isolates a single save off the main thread and
// packages it into the requested output format
//
// Message protocol:
//   IN:  { mcr: ArrayBuffer, slotIndex: number, format?: 'vmp'|'mcr'|'gme' }
//        (mcr is the full, already-unwrapped 128KB raw memory card; format
//        defaults to 'vmp')
//   OUT: { type: 'progress', pct: 0-100, label: string }
//   OUT: { type: 'done', result: ArrayBuffer }  (.vmp/.mcr/.gme bytes)
//   OUT: { type: 'error', message: string }
//
// One worker instance handles one slot; the UI spins up several in parallel
// for a multi-slot extraction, mirroring patch-worker.js's per-item pattern.

import { extractSaveMcr } from './save/mcr.js';
import { buildVmp } from './save/vmp.js';
import { wrapGme } from './save/gme.js';

function progress(pct, label) {
  self.postMessage({ type: 'progress', pct, label });
}

self.onmessage = async function(e) {
  try {
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
