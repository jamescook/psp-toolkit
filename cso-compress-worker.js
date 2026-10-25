// CSO/ZSO Compression Web Worker — parallel deflate/LZ4 compression of ISO blocks
//
// The main thread splits the ISO's blocks into ranges and dispatches each
// range to a separate cso-compress-worker instance. This enables multi-core
// compression — the "Workers" slider in the Convert tab controls how many
// run simultaneously.
//
// Each worker reads its own range of 2048-byte blocks from the ISO in ~4 MB
// batches (read-blocks.js), compresses them via deflateRaw (CSO) or LZ4 (ZSO),
// and returns the compressed parts + uncompressed flags to the main thread.
//
// Message protocol:
//   IN:  { file: File, firstBlock: number, endBlock: number, targetFormat: 'CSO'|'ZSO' }
//   OUT: { type: 'progress', blockIndex, totalBlocks }
//   OUT: { type: 'done', parts: Uint8Array[], uncompressedFlags: boolean[] }
//   OUT: { type: 'error', message }
//
// zlib (deflateRaw) is prepended by build.js banner — no import needed

import { compressBlock } from './cso/lz4.js';
import { receiveFiles } from './remote-file.js';
import { readBlockBatches } from './read-blocks.js';

const CSO_BLOCK_SIZE = 2048;

self.onmessage = async function(e) {
  try {
    const { file, firstBlock, endBlock, targetFormat } = receiveFiles(e.data);
    const totalBlocks = endBlock - firstBlock;
    const parts = [];
    const uncompressedFlags = [];

    for await (const batch of readBlockBatches(file, firstBlock, endBlock, CSO_BLOCK_SIZE)) {
      for (let j = 0; j < batch.blocks.length; j++) {
        const raw = batch.blocks[j];
        const compressed = targetFormat === 'CSO' ? deflateRaw(raw) : compressBlock(raw);

        if (compressed.length >= raw.length) {
          // raw is a view into the batch; copy it so each part owns its buffer
          parts.push(raw.slice());
          uncompressedFlags.push(true);
        } else {
          parts.push(compressed);
          uncompressedFlags.push(false);
        }

        const i = batch.firstBlock - firstBlock + j;
        if (i % 256 === 0) {
          self.postMessage({ type: 'progress', blockIndex: i, totalBlocks });
        }
      }
    }

    // Transfer compressed buffers back to main thread
    const transferable = parts.map(p => p.buffer);
    self.postMessage({
      type: 'done',
      parts,
      uncompressedFlags,
    }, transferable);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
