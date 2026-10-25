// Run one job on a Web Worker and wait for it.
//
// Every worker in this app speaks the same protocol: it posts
// { type: 'progress', ... } any number of times, then one { type: 'done', ... }.
// A worker that fails either posts { type: 'error', message } or crashes;
// the zip worker only ever crashes.
//
// The caller constructs the worker itself, calling new Worker with the file
// name as a string literal: build.js finds each such call, bundles that file
// and swaps in the inlined code.
//
// A File in the message is never posted to the worker: WebKit will not let a
// worker read one when the page came from file://. It goes as a descriptor,
// and the worker reads it through a MessagePort served here; remote-file.js
// is the worker's half.

/**
 * Post a message to a worker and settle when it finishes. The worker is
 * terminated once the job settles, whichever way.
 * @param {Worker} worker
 * @param {*} message - any File or Blob in it, at any depth, reaches the
 *   worker as a descriptor for remote-file.js's receiveFiles()
 * @param {object} [options]
 * @param {ArrayBuffer[]} [options.transfer] - buffers to move to the worker rather than copy
 * @param {function(object): void} [options.onProgress] - called with each progress message
 * @param {AbortSignal} [options.signal] - aborting terminates the worker and
 *   rejects with an Error named 'AbortError'
 * @returns {Promise<object>} the worker's 'done' message. On a reported error
 *   it rejects with an Error whose `workerMessage` is the worker's full error
 *   message, so extra fields such as `buildLog` survive.
 */
function runWorker(worker, message, { transfer = [], onProgress, signal } = {}) {
  if (signal?.aborted) {
    worker.terminate();
    return Promise.reject(createCancelledError());
  }
  const files = [];
  const posted = describeFiles(message, files);
  let filePort = null;
  if (files.length) {
    const channel = new MessageChannel();
    filePort = channel.port1;
    filePort.onmessage = (e) => serveFileRead(filePort, files, e.data);
    posted.filePort = channel.port2;
    transfer = [...transfer, channel.port2];
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      finish();
      reject(createCancelledError());
    };
    const finish = () => {
      worker.terminate();
      filePort?.close();
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg);
      } else if (msg.type === 'done') {
        finish();
        resolve(msg);
      } else if (msg.type === 'error') {
        finish();
        reject(Object.assign(new Error(msg.message), { workerMessage: msg }));
      }
    };
    // A crash (an uncaught exception, or a script that failed to load) arrives
    // as an ErrorEvent, whose message is sometimes empty.
    worker.onerror = function(event) {
      console.error('Worker error:', event);
      finish();
      reject(new Error(`Worker error: ${event.message || `${event.filename}:${event.lineno} ${event.type}`}`));
    };
    worker.postMessage(posted, transfer);
  });
}

/** The error a cancelled job rejects with; check `err.name === 'AbortError'`. */
function createCancelledError() {
  return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

/** Copy `value`, swapping each File or Blob for { remoteFile, name, size } and collecting it in `files`. */
function describeFiles(value, files) {
  if (value instanceof Blob) {
    files.push(value);
    return { remoteFile: files.length - 1, name: value.name, size: value.size };
  }
  if (Array.isArray(value)) return value.map(v => describeFiles(v, files));
  // toString, not instanceof Object: a message built in another realm (a test's vm context) is still plain.
  if (Object.prototype.toString.call(value) !== '[object Object]') return value;
  const out = {};
  for (const [key, field] of Object.entries(value)) out[key] = describeFiles(field, files);
  return out;
}

/** Answer one read request from a worker's remote-file.js. */
async function serveFileRead(port, files, { id, index, start, end }) {
  try {
    const buffer = await files[index].slice(start, end).arrayBuffer();
    port.postMessage({ id, buffer }, [buffer]);
  } catch (err) {
    port.postMessage({ id, error: err.message });
  }
}

/**
 * Split blockCount blocks into up to workerCount contiguous ranges and run
 * each range on its own worker, all at once. Each worker reads its own range
 * (read-blocks.js), so the page never holds the disc. Progress messages must
 * carry blockIndex and totalBlocks, as the compression workers' do.
 * @param {function(): Worker} createWorker - must call new Worker with a literal file name
 * @param {number} blockCount
 * @param {number} workerCount - an upper bound: never more workers than blocks
 * @param {object} options
 * @param {function({start: number, end: number}): *} options.message - the message
 *   for blocks [start, end)
 * @param {function(number, number): void} [options.onProgress] - called with the
 *   fraction complete averaged across workers (0–1) and the number of workers
 * @param {AbortSignal} [options.signal] - aborting stops every worker
 * @returns {Promise<object[]>} each worker's 'done' message, in range order.
 *   If one worker fails, the others are stopped.
 */
function runWorkerPool(createWorker, blockCount, workerCount, { message, onProgress, signal }) {
  const blocksPerWorker = Math.ceil(blockCount / workerCount);
  const ranges = [];
  for (let start = 0; start < blockCount; start += blocksPerWorker) {
    ranges.push({ start, end: Math.min(start + blocksPerWorker, blockCount) });
  }

  const stopAll = new AbortController();
  if (signal?.aborted) stopAll.abort();
  signal?.addEventListener('abort', () => stopAll.abort());

  const workerProgress = new Array(ranges.length).fill(0);
  return Promise.all(ranges.map((range, i) => runWorker(createWorker(), message(range), {
    signal: stopAll.signal,
    onProgress: (msg) => {
      workerProgress[i] = msg.blockIndex / msg.totalBlocks;
      const average = workerProgress.reduce((a, b) => a + b, 0) / ranges.length;
      onProgress?.(average, ranges.length);
    },
  }))).catch((err) => {
    stopAll.abort();
    throw err;
  });
}
