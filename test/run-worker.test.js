import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'run-worker.js'), 'utf8');

function loadRunWorker(console = { error() {} }) {
  const ctx = vm.createContext({ Promise, Error, console });
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
