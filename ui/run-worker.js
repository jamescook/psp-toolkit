// Run one job on a Web Worker and wait for it.
//
// Every worker in this app speaks the same protocol: it posts
// { type: 'progress', ... } any number of times, then one { type: 'done', ... }.
// A worker that fails either posts { type: 'error', message } or crashes;
// the compress, cso-compress and zip workers only ever crash.
//
// The caller constructs the worker itself, as a literal new Worker('x.js'):
// build.js finds that exact text and swaps in the inlined worker code.

/**
 * Post a message to a worker and settle when it finishes. The worker is
 * terminated once the job settles, whichever way.
 * @param {Worker} worker
 * @param {*} message
 * @param {object} [options]
 * @param {ArrayBuffer[]} [options.transfer] - buffers to move to the worker rather than copy
 * @param {function(object): void} [options.onProgress] - called with each progress message
 * @returns {Promise<object>} the worker's 'done' message. On a reported error
 *   it rejects with an Error whose `workerMessage` is the worker's full error
 *   message, so extra fields such as `buildLog` survive.
 */
function runWorker(worker, message, { transfer = [], onProgress } = {}) {
  return new Promise((resolve, reject) => {
    worker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(Object.assign(new Error(msg.message), { workerMessage: msg }));
      }
    };
    // A crash (an uncaught exception, or a script that failed to load) arrives
    // as an ErrorEvent, whose message is sometimes empty.
    worker.onerror = function(event) {
      console.error('Worker error:', event);
      worker.terminate();
      reject(new Error(`Worker error: ${event.message || `${event.filename}:${event.lineno} ${event.type}`}`));
    };
    worker.postMessage(message, transfer);
  });
}

/**
 * Split blocks into up to workerCount contiguous ranges and run each range on
 * its own worker, all at once. Progress messages must carry blockIndex and
 * totalBlocks, as the compression workers' do.
 * @param {function(): Worker} createWorker - must contain the literal new Worker('x.js')
 * @param {Array} blocks
 * @param {number} workerCount - an upper bound: never more workers than blocks
 * @param {object} options
 * @param {function(Array): *} options.message - the message for one range
 * @param {function(Array): ArrayBuffer[]} [options.transfer] - buffers to move for one range
 * @param {function(number, number): void} [options.onProgress] - called with the
 *   fraction complete averaged across workers (0–1) and the number of workers
 * @returns {Promise<object[]>} each worker's 'done' message, in range order
 */
function runWorkerPool(createWorker, blocks, workerCount, { message, transfer, onProgress }) {
  const blocksPerWorker = Math.ceil(blocks.length / workerCount);
  const ranges = [];
  for (let start = 0; start < blocks.length; start += blocksPerWorker) {
    ranges.push(blocks.slice(start, start + blocksPerWorker));
  }

  const workerProgress = new Array(ranges.length).fill(0);
  return Promise.all(ranges.map((range, i) => runWorker(createWorker(), message(range), {
    transfer: transfer?.(range),
    onProgress: (msg) => {
      workerProgress[i] = msg.blockIndex / msg.totalBlocks;
      const average = workerProgress.reduce((a, b) => a + b, 0) / ranges.length;
      onProgress?.(average, ranges.length);
    },
  })));
}
