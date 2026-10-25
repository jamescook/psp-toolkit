// CSO/ZSO Compression Web Worker — parallel deflate/LZ4 compression of ISO blocks
//
// The main thread splits the ISO file into block ranges and dispatches each
// range to a separate cso-compress-worker instance. This enables multi-core
// compression — the "Workers" slider in the Convert tab controls how many
// run simultaneously.
//
// Each worker receives a batch of raw 2048-byte ISO blocks (as transferred
// ArrayBuffers), compresses them via deflateRaw (CSO) or LZ4 (ZSO), and
// returns the compressed parts + uncompressed flags back to the main thread.
//
// Message protocol:
//   IN:  { blocks: ArrayBuffer[], targetFormat: 'CSO'|'ZSO' }
//   OUT: { type: 'progress', blockIndex, totalBlocks }
//   OUT: { type: 'done', parts: Uint8Array[], uncompressedFlags: boolean[] }
//
// zlib (deflateRaw) is prepended by build.js banner — no import needed

import { compressBlock } from './cso/lz4.js';

self.onmessage = function(e) {
  const { blocks, targetFormat } = e.data;
  const totalBlocks = blocks.length;
  const parts = [];
  const uncompressedFlags = [];

  for (let i = 0; i < totalBlocks; i++) {
    const raw = new Uint8Array(blocks[i]);

    let compressed;
    if (targetFormat === 'CSO') {
      compressed = deflateRaw(raw);
    } else {
      compressed = compressBlock(raw);
    }

    if (compressed.length >= raw.length) {
      parts.push(raw);
      uncompressedFlags.push(true);
    } else {
      parts.push(compressed);
      uncompressedFlags.push(false);
    }

    if (i % 256 === 0) {
      self.postMessage({ type: 'progress', blockIndex: i, totalBlocks });
    }
  }

  // Transfer compressed buffers back to main thread
  const transferable = parts.map(p => p.buffer);
  self.postMessage({
    type: 'done',
    parts,
    uncompressedFlags,
  }, transferable);
};
