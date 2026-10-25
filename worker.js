// CSO/ZSO/ISO conversion Web Worker
//
// Handles all 6 conversion paths between CSO, ZSO, and ISO formats.
// Runs off the main thread so the UI stays responsive during multi-GB files.
//
// Message protocol:
//   IN:  { file: File, sourceFormat: 'CSO'|'ZSO'|'ISO', targetFormat: same }
//   OUT: { type: 'progress', pct: 0-1, label: string }
//   OUT: { type: 'done', result: Uint8Array }  (transferred, not copied)
//   OUT: { type: 'error', message: string }
//
// CSO format (CISO): deflate-compressed PSP disc images
//   Spec: https://www.psdevwiki.com/psp/CSOFileFormat
//   Header: "CISO" magic, 24 bytes, followed by uint32 index table
//   Each index entry's high bit = 1 means uncompressed block
//   Block data is raw deflate (RFC 1951)
//
// ZSO format (ZISO): LZ4-compressed variant of CSO
//   Same header/index structure as CSO but with "ZISO" magic
//   Block data is LZ4 block format (no frame header)
//   Faster decompression on PSP hardware at cost of slightly larger files
//
// zlib (deflateRaw/inflateRaw) is prepended by build.js banner — no import needed

import { decompressToISO, compressFromISO, transcompress } from './cso/cso.js';
import { receiveFiles } from './remote-file.js';

function progress(pct, label) {
  self.postMessage({ type: 'progress', pct, label });
}

// ── Message handler ──────────────────────────────────────────────────────────
self.onmessage = async function(e) {
  const { file, sourceFormat, targetFormat } = receiveFiles(e.data);
  try {
    let result;
    if (targetFormat === 'ISO') {
      result = await decompressToISO(file, progress);
    } else if (sourceFormat === 'ISO') {
      result = await compressFromISO(file, targetFormat, progress);
    } else {
      result = await transcompress(file, sourceFormat, targetFormat, progress);
    }
    self.postMessage({ type: 'done', result }, [result.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
