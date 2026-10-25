// Read a range of fixed-size blocks from a disc image, a batch at a time.
//
// The parallel compressors (cso-compress-worker.js, compress-worker.js) each
// take a range of blocks. Reading them one block at a time costs a round trip
// per 2 KB CSO block — about 540,000 for a 1 GB disc — and reading the whole
// range at once holds a big share of the disc in memory. A batch of about
// 4 MB is one read each and small enough for a phone.

export const BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Yield { firstBlock, blocks } for blocks [firstBlock, endBlock) of `file`,
 * each batch read with one slice. The last block of the file may be short.
 * @param {{ size: number, slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }} file
 * @param {number} firstBlock
 * @param {number} endBlock - exclusive
 * @param {number} blockSize - bytes per block (2048 for CSO, 0x9300 for EBOOT)
 * @param {number} [batchBytes]
 */
export async function* readBlockBatches(file, firstBlock, endBlock, blockSize, batchBytes = BATCH_BYTES) {
  const blocksPerBatch = Math.max(1, Math.floor(batchBytes / blockSize));
  for (let batchStart = firstBlock; batchStart < endBlock; batchStart += blocksPerBatch) {
    const batchEnd = Math.min(batchStart + blocksPerBatch, endBlock);
    const start = batchStart * blockSize;
    const end = Math.min(batchEnd * blockSize, file.size);
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    const blocks = [];
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      blocks.push(bytes.subarray(offset, Math.min(offset + blockSize, bytes.length)));
    }
    yield { firstBlock: batchStart, blocks };
  }
}
