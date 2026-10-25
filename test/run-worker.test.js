import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'run-worker.js'), 'utf8');

function loadRunWorker(console = { error() {} }) {
  const ctx = vm.createContext({ Promise, Error, Blob, MessageChannel, console });
  vm.runInContext(src, ctx);
  return ctx.runWorker;
}

/** Stands in for a Web Worker: records what it was sent, and lets the test reply. */
class FakeWorker {
  constructor() {
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(message, transfer) { this.posted.push({ message, transfer }); }
  terminate() { this.terminated = true; }
  reply(data) { this.onmessage({ data }); }
  crash(event) { this.onerror(event); }
}

describe('runWorker', () => {
  it('resolves with the done message and stops the worker', async () => {
    const runWorker = loadRunWorker();
    const worker = new FakeWorker();
    const job = runWorker(worker, { rom: 1 });
    worker.reply({ type: 'done', result: 'patched', format: 'IPS' });

    const done = await job;
    assert.equal(done.result, 'patched');
    assert.equal(done.format, 'IPS');
    assert.equal(worker.terminated, true);
  });

  it('hands each progress message to onProgress, in order, without stopping the worker', async () => {
    const runWorker = loadRunWorker();
    const worker = new FakeWorker();
    const seen = [];
    const job = runWorker(worker, {}, { onProgress: (msg) => seen.push([msg.pct, msg.label]) });
    worker.reply({ type: 'progress', pct: 0.25, label: 'Reading' });
    worker.reply({ type: 'progress', pct: 0.75, label: 'Writing' });
    assert.equal(worker.terminated, false);
    worker.reply({ type: 'done' });
    await job;

    assert.deepEqual(seen, [[0.25, 'Reading'], [0.75, 'Writing']]);
  });

  it('posts the message with its transfer list', () => {
    const runWorker = loadRunWorker();
    const worker = new FakeWorker();
    const buffer = new ArrayBuffer(8);
    runWorker(worker, { data: buffer }, { transfer: [buffer] });

    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].message.data, buffer);
    assert.deepEqual(worker.posted[0].transfer, [buffer]);
  });

  it('rejects with the reported message, keeps the rest of the report, and stops the worker', async () => {
    const runWorker = loadRunWorker();
    const worker = new FakeWorker();
    const job = runWorker(worker, {});
    worker.reply({ type: 'error', message: 'Verification failed', buildLog: 'log text' });

    await assert.rejects(job, (err) => {
      assert.equal(err.message, 'Verification failed');
      assert.equal(err.workerMessage.buildLog, 'log text');
      return true;
    });
    assert.equal(worker.terminated, true);
  });

  it('rejects when the worker crashes, logs the crash, and stops the worker', async () => {
    const logged = [];
    const runWorker = loadRunWorker({ error: (...args) => logged.push(args) });
    const worker = new FakeWorker();
    const job = runWorker(worker, {});
    const event = { message: 'Uncaught RangeError: Invalid array length' };
    worker.crash(event);

    await assert.rejects(job, { message: 'Worker error: Uncaught RangeError: Invalid array length' });
    assert.equal(worker.terminated, true);
    assert.deepEqual(logged, [['Worker error:', event]]);
  });

  it('names the file and line when a crash carries no message', async () => {
    const runWorker = loadRunWorker();
    const worker = new FakeWorker();
    const job = runWorker(worker, {});
    worker.crash({ message: '', filename: 'blob:abc', lineno: 12, type: 'error' });

    await assert.rejects(job, { message: 'Worker error: blob:abc:12 error' });
  });
});

function loadRunWorkerPool() {
  const ctx = vm.createContext({ Promise, Error, Blob, MessageChannel, console: { error() {} } });
  vm.runInContext(src, ctx);
  return ctx.runWorkerPool;
}

/** Starts a pool over `blocks` and returns it with the fake workers it created. */
function startPool(blocks, workerCount, options = {}) {
  const runWorkerPool = loadRunWorkerPool();
  const workers = [];
  const pool = runWorkerPool(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, blocks, workerCount, { message: (range) => ({ range }), ...options });
  return { pool, workers };
}

describe('runWorkerPool', () => {
  it('gives each worker one contiguous range and returns the results in range order', async () => {
    const { pool, workers } = startPool(['a', 'b', 'c', 'd', 'e'], 2);

    assert.deepEqual(workers.map(w => w.posted[0].message.range), [['a', 'b', 'c'], ['d', 'e']]);
    workers[1].reply({ type: 'done', result: 'second' });
    workers[0].reply({ type: 'done', result: 'first' });
    assert.deepEqual((await pool).map(done => done.result), ['first', 'second']);
  });

  it('starts no more workers than there are blocks', async () => {
    const { pool, workers } = startPool(['a', 'b'], 8);

    assert.equal(workers.length, 2);
    for (const worker of workers) worker.reply({ type: 'done' });
    await pool;
  });

  it('reports progress as the average across workers, with the worker count', async () => {
    const seen = [];
    const { pool, workers } = startPool(['a', 'b', 'c', 'd'], 2, {
      onProgress: (fraction, workerCount) => seen.push([fraction, workerCount]),
    });
    workers[0].reply({ type: 'progress', blockIndex: 1, totalBlocks: 2 });
    workers[1].reply({ type: 'progress', blockIndex: 2, totalBlocks: 2 });
    for (const worker of workers) worker.reply({ type: 'done' });
    await pool;

    assert.deepEqual(seen, [[0.25, 2], [0.75, 2]]);
  });

  it('transfers the buffers chosen for each range', async () => {
    const { pool, workers } = startPool(['a', 'b'], 2, { transfer: (range) => range.map(x => x + '!') });

    assert.deepEqual(workers.map(w => w.posted[0].transfer), [['a!'], ['b!']]);
    for (const worker of workers) worker.reply({ type: 'done' });
    await pool;
  });

  it('rejects when any worker fails', async () => {
    const { pool, workers } = startPool(['a', 'b'], 2);
    workers[0].reply({ type: 'done' });
    workers[1].reply({ type: 'error', message: 'out of memory' });

    await assert.rejects(pool, { message: 'out of memory' });
  });
});
