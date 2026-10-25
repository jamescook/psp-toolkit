import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readBlockBatches } from '../read-blocks.js';

/** A File-like whose slice() calls are counted. */
function countingFile(bytes) {
  const file = new File([bytes], 'disc.iso');
  let slices = 0;
  return {
    size: file.size,
    get slices() { return slices; },
    slice(start, end) { slices++; return file.slice(start, end); },
  };
}

function patterned(length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 13 + (i >>> 9)) & 0xFF;
  return bytes;
}

async function collect(file, firstBlock, endBlock, blockSize, batchBytes) {
  const batches = [];
  for await (const batch of readBlockBatches(file, firstBlock, endBlock, blockSize, batchBytes)) batches.push(batch);
  return batches;
}

describe('readBlockBatches', () => {
  it('yields each block of the range in order, in batches no bigger than the batch size', async () => {
    const bytes = patterned(10 * 100);
    const file = countingFile(bytes);
    const batches = await collect(file, 2, 9, 100, 300);

    assert.deepEqual(batches.map(b => [b.firstBlock, b.blocks.length]), [[2, 3], [5, 3], [8, 1]]);
    const blocks = batches.flatMap(b => b.blocks);
    blocks.forEach((block, i) => assert.deepEqual(block, bytes.subarray((2 + i) * 100, (3 + i) * 100)));
    assert.equal(file.slices, 3);
  });

  it('gives a short last block when the file ends mid-block', async () => {
    const bytes = patterned(250);
    const batches = await collect(countingFile(bytes), 0, 3, 100, 1000);

    assert.deepEqual(batches[0].blocks.map(b => b.length), [100, 100, 50]);
    assert.deepEqual(batches[0].blocks[2], bytes.subarray(200));
  });

  it('reads at least one block per batch when a block is bigger than the batch size', async () => {
    const file = countingFile(patterned(400));
    const batches = await collect(file, 0, 2, 200, 50);
    assert.deepEqual(batches.map(b => b.blocks.length), [1, 1]);
  });
});
