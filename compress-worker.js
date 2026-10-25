// Compression Web Worker — parallel deflate compression of ISO blocks
//
// The main thread splits the disc image's blocks into ranges and dispatches
// each range to a separate compress-worker instance. This enables multi-core
// compression — the "Workers" slider in the UI controls how many of these
// run simultaneously.
//
// Each worker reads its own range of ISO_BLOCK_SIZE blocks from the disc in
// ~4 MB batches (read-blocks.js), compresses each batch via compressBlocks()
// from psisoimg.js, and returns the compressed parts + index entries to the
// main thread. Index offsets are relative to the start of this range.
//
// Message protocol:
//   IN:  { file: File, firstBlock: number, endBlock: number, compressionLevel: 0-9 }
//   OUT: { type: 'progress', blockIndex, totalBlocks }
//   OUT: { type: 'done', parts: Uint8Array[], indexEntries, stats }
//   OUT: { type: 'error', message }

import { compressBlocks } from './eboot/psisoimg.js';
import { receiveFiles } from './remote-file.js';
import { readBlockBatches } from './read-blocks.js';

const ISO_BLOCK_SIZE = 0x9300; // 37,632 bytes — the PSISOIMG block (psisoimg.js)

self.onmessage = async function(e) {
  try {
    const { file, firstBlock, endBlock, compressionLevel } = receiveFiles(e.data);
    const totalBlocks = endBlock - firstBlock;
    const parts = [];
    const indexEntries = [];
    const stats = { compressedCount: 0, uncompressedCount: 0, totalCompressedBytes: 0 };

    for await (const batch of readBlockBatches(file, firstBlock, endBlock, ISO_BLOCK_SIZE)) {
      const done = batch.firstBlock - firstBlock;
      const result = compressBlocks(batch.blocks, compressionLevel, {
        onProgress(blockIndex) {
          self.postMessage({ type: 'progress', blockIndex: done + blockIndex, totalBlocks });
        },
      });
      // compressBlocks numbers offsets from the start of its batch; shift them to this range's.
      for (const entry of result.indexEntries) {
        indexEntries.push({ ...entry, offset: entry.offset + stats.totalCompressedBytes });
      }
      parts.push(...result.parts);
      stats.compressedCount += result.stats.compressedCount;
      stats.uncompressedCount += result.stats.uncompressedCount;
      stats.totalCompressedBytes += result.stats.totalCompressedBytes;
    }

    // Transfer compressed buffers back to main thread
    const transferable = parts.map(p => p.buffer);
    self.postMessage({ type: 'done', parts, indexEntries, stats }, transferable);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
