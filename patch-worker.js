// Patch Web Worker — applies IPS/PPF/BPS/xdelta patches off the main thread
//
// Message protocol:
//   IN:  { rom: File, patch: File }
//   OUT: { type: 'progress', pct: 0-100, label: string }
//   OUT: { type: 'done', result: ArrayBuffer, format: string }
//   OUT: { type: 'error', message: string }

import { applyPatch } from './patch/index.js';
import { receiveFiles } from './remote-file.js';

function progress(pct, label) {
  self.postMessage({ type: 'progress', pct, label });
}

self.onmessage = async function(e) {
  try {
    const { rom, patch } = receiveFiles(e.data);

    progress(0, 'Reading disc image...');
    const romBuf = await rom.arrayBuffer();

    progress(5, 'Reading patch file...');
    const patchBuf = await patch.arrayBuffer();

    progress(10, 'Applying patch...');
    const romData = new Uint8Array(romBuf);
    const patchData = new Uint8Array(patchBuf);
    const { result, format } = await applyPatch(romData, patchData, pct => {
      progress(10 + Math.round(pct * 0.9), 'Applying patch...');
    });

    progress(100, 'Done');
    self.postMessage(
      { type: 'done', result: result.buffer, format },
      [result.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
