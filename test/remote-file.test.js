import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiveFiles, CHUNK_BYTES } from '../remote-file.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'run-worker.js'), 'utf8');

function loadRunWorker() {
  const ctx = vm.createContext({ Promise, Error, Blob, MessageChannel, ArrayBuffer, console: { error() {} } });
  vm.runInContext(src, ctx);
  return ctx.runWorker;
}

/** Stands in for a Web Worker: keeps what it was sent so the test can play the worker's side. */
class FakeWorker {
  postMessage(message) { this.message = message; }
  terminate() {}
  finish() { this.onmessage({ data: { type: 'done' } }); }
}

/** A File whose slice() calls are counted, so a test can see how often the page was asked. */
class CountingFile extends File {
  constructor(bytes, name) {
    super([bytes], name);
    this.slices = 0;
  }
  slice(...args) {
    this.slices++;
    return super.slice(...args);
  }
}

function patterned(length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 7 + (i >>> 8)) & 0xFF;
  return bytes;
}

/** Run a job whose message holds `message`, and return what the worker side sees. */
function sendToWorker(message) {
  const runWorker = loadRunWorker();
  const worker = new FakeWorker();
  const job = runWorker(worker, message);
  return { data: receiveFiles(worker.message), finish: () => { worker.finish(); return job; } };
}

describe('files sent to a worker', () => {
  it('arrive with the same name and size, and read back the same bytes', async () => {
    const bytes = patterned(5000);
    const { data, finish } = sendToWorker({ file: new File([bytes], 'game.iso'), targetFormat: 'CSO' });

    assert.equal(data.file.name, 'game.iso');
    assert.equal(data.file.size, 5000);
    assert.equal(data.targetFormat, 'CSO');
    assert.deepEqual(new Uint8Array(await data.file.slice(100, 300).arrayBuffer()), bytes.slice(100, 300));
    assert.deepEqual(new Uint8Array(await data.file.arrayBuffer()), bytes);
    await finish();
  });

  it('are found inside arrays, and other values pass through unchanged', async () => {
    const icon = new Uint8Array([1, 2, 3]);
    const { data, finish } = sendToWorker({
      files: [new File([patterned(10)], 'disc1.bin'), new File([patterned(20)], 'disc2.bin')],
      icon0: icon,
      region: 1,
    });

    assert.deepEqual(data.files.map(f => [f.name, f.size]), [['disc1.bin', 10], ['disc2.bin', 20]]);
    assert.deepEqual(new Uint8Array(await data.files[1].slice(5, 20).arrayBuffer()), patterned(20).slice(5));
    assert.equal(data.icon0, icon);
    assert.equal(data.region, 1);
    await finish();
  });

  it('clip a read that runs past the end, as a File does', async () => {
    const { data, finish } = sendToWorker({ file: new File([patterned(100)], 'x.bin') });

    assert.deepEqual(new Uint8Array(await data.file.slice(90, 200).arrayBuffer()), patterned(100).slice(90));
    await finish();
  });

  it('serve many small reads in order with a few large reads of the real file', async () => {
    const length = CHUNK_BYTES * 2 + 1000;
    const bytes = patterned(length);
    const file = new CountingFile(bytes, 'big.iso');
    const { data, finish } = sendToWorker({ file });

    const BLOCK = 2048;
    for (let start = 0; start < length; start += BLOCK) {
      const got = new Uint8Array(await data.file.slice(start, start + BLOCK).arrayBuffer());
      if (got[0] !== bytes[start] || got.length !== Math.min(BLOCK, length - start)) {
        assert.fail(`wrong bytes at ${start}`);
      }
    }
    assert.equal(file.slices, 3);
    await finish();
  });
});
