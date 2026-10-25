import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'job-queue.js'), 'utf8');

function loadQueue(options = {}) {
  const ctx = vm.createContext({ Promise, Error, Map, AbortController });
  vm.runInContext(src, ctx);
  const saved = [];
  const queue = ctx.createJobQueue({ save: async (outputs) => { saved.push(...outputs.map(o => o.name)); }, ...options });
  return { queue, saved };
}

/** A job whose run waits until the test finishes or fails it. */
function job(key, settings = {}) {
  let finish, fail;
  const j = {
    key,
    kind: 'convert',
    label: key,
    settings,
    runs: 0,
    seenSettings: null,
    signal: null,
    run(runSettings, { onProgress, signal }) {
      j.runs++;
      j.seenSettings = runSettings;
      j.signal = signal;
      j.onProgress = onProgress;
      return new Promise((resolve, reject) => {
        finish = () => resolve([{ name: `${key}.out`, data: new Uint8Array(1) }]);
        fail = (message) => reject(new Error(message));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })));
      });
    },
    finish: () => finish(),
    fail: (message) => fail(message),
  };
  return j;
}

const tick = () => new Promise(r => setTimeout(r, 0));
const states = (queue) => Array.from(queue.jobs, j => `${j.label}:${j.state}`);

describe('job queue', () => {
  it('runs one job at a time, in the order added, and saves each output as it finishes', async () => {
    const { queue, saved } = loadQueue();
    const a = job('a'), b = job('b');
    queue.add(a);
    queue.add(b);
    await tick();
    assert.deepEqual(states(queue), ['a:running', 'b:waiting']);
    assert.equal(b.runs, 0);

    a.finish();
    await tick();
    assert.deepEqual(saved, ['a.out']);
    assert.deepEqual(states(queue), ['a:done', 'b:running']);

    b.finish();
    await tick();
    assert.deepEqual(saved, ['a.out', 'b.out']);
  });

  it('ignores a job with the same key as one waiting or running', async () => {
    const { queue } = loadQueue();
    assert.equal(queue.add(job('a')), 'added');
    assert.equal(queue.add(job('a')), 'duplicate');
    assert.equal(queue.jobs.length, 1);
  });

  it('accepts a job again once the earlier one has finished', async () => {
    const { queue } = loadQueue();
    const a = job('a');
    queue.add(a);
    await tick();
    a.finish();
    await tick();
    assert.equal(queue.add(job('a')), 'added');
  });

  it('holds at most 10 jobs waiting or running', async () => {
    const { queue } = loadQueue();
    for (let i = 0; i < 10; i++) assert.equal(queue.add(job(`job${i}`)), 'added');
    assert.equal(queue.add(job('one too many')), 'full');
  });

  it('carries on with the next job after one fails, and records why', async () => {
    const { queue, saved } = loadQueue();
    const a = job('a'), b = job('b');
    queue.add(a);
    queue.add(b);
    await tick();
    a.fail('disc unreadable');
    await tick();
    assert.deepEqual(states(queue), ['a:failed', 'b:running']);
    assert.equal(queue.jobs[0].message, 'disc unreadable');
    b.finish();
    await tick();
    assert.deepEqual(saved, ['b.out']);
  });

  it('removes a waiting job without running it', async () => {
    const { queue } = loadQueue();
    const a = job('a'), b = job('b');
    queue.add(a);
    queue.add(b);
    queue.remove(queue.jobs[1].id);
    assert.deepEqual(Array.from(queue.jobs, j => j.label), ["a"]);
    await tick();
    a.finish();
    await tick();
    assert.equal(b.runs, 0);
  });

  it('cancels the running job and moves on', async () => {
    const { queue, saved } = loadQueue();
    const a = job('a'), b = job('b');
    queue.add(a);
    queue.add(b);
    await tick();
    queue.remove(queue.jobs[0].id);
    await tick();
    assert.equal(a.signal.aborted, true);
    assert.deepEqual(states(queue), ['a:cancelled', 'b:running']);
    b.finish();
    await tick();
    assert.deepEqual(saved, ['b.out']);
  });

  it('shows a note a job returns with its outputs', async () => {
    const { queue, saved } = loadQueue();
    queue.add({
      key: 'p', kind: 'patch', label: 'p', settings: {},
      run: async () => ({ outputs: [{ name: 'p.bin', data: new Uint8Array(1) }], note: 'XDELTA patch' }),
    });
    await tick();
    await tick();
    assert.deepEqual(saved, ['p.bin']);
    assert.equal(queue.jobs[0].message, 'p.bin · XDELTA patch');
  });

  it('cannot cancel a job once it is saving its files', async () => {
    let finishSave;
    const ctx = vm.createContext({ Promise, Error, Map, AbortController });
    vm.runInContext(src, ctx);
    const queue = ctx.createJobQueue({ save: () => new Promise(r => { finishSave = r; }) });
    queue.add({ key: 'a', kind: 'convert', label: 'a', settings: {}, run: async () => [{ name: 'a.out', data: new Uint8Array(1) }] });
    await tick();
    await tick();
    assert.equal(queue.jobs[0].state, 'saving');

    queue.remove(queue.jobs[0].id);
    finishSave();
    await tick();
    assert.equal(queue.jobs[0].state, 'done');
  });

  it('keeps files a job attaches for the user, whether it finishes or fails', async () => {
    const { queue } = loadQueue();
    const log = { name: 'build-log.txt', data: new Uint8Array(1) };
    queue.add({ key: 'ok', kind: 'eboot', label: 'ok', settings: {},
      run: async () => ({ outputs: [{ name: 'ok.zip', data: new Uint8Array(1) }], attachments: [log] }) });
    queue.add({ key: 'bad', kind: 'eboot', label: 'bad', settings: {},
      run: async () => { throw Object.assign(new Error('verification failed'), { attachments: [log] }); } });
    await tick();
    await tick();
    await tick();
    assert.deepEqual(Array.from(queue.jobs, j => [j.state, j.attachments.map(a => a.name)]),
      [['done', ['build-log.txt']], ['failed', ['build-log.txt']]]);
  });

  it('reports progress on the running job', async () => {
    const { queue } = loadQueue();
    const a = job('a');
    queue.add(a);
    await tick();
    a.onProgress(0.4, 'Compressing');
    assert.equal(queue.jobs[0].progress, 0.4);
    assert.equal(queue.jobs[0].message, 'Compressing');
  });

  it('skips a job being edited, keeps its place, and runs the edited settings', async () => {
    const { queue } = loadQueue();
    const a = job('a'), b = job('b', { level: 5 }), c = job('c');
    queue.add(a);
    queue.add(b);
    queue.add(c);
    await tick();
    const editing = queue.startEditing(queue.jobs[1].id);
    assert.deepEqual(editing.settings, { level: 5 });

    a.finish();
    await tick();
    assert.deepEqual(states(queue), ['a:done', 'b:editing', 'c:running']);

    assert.equal(queue.finishEditing(queue.jobs[1].id, { key: 'b', label: 'b', settings: { level: 9 } }), 'saved');
    c.finish();
    await tick();
    assert.deepEqual(states(queue), ['a:done', 'b:running', 'c:done']);
    assert.deepEqual(b.seenSettings, { level: 9 });
  });

  it('refuses an edit that turns a job into a copy of another one', async () => {
    const { queue } = loadQueue();
    queue.add(job('a'));
    queue.add(job('b'));
    queue.startEditing(queue.jobs[1].id);
    assert.equal(queue.finishEditing(queue.jobs[1].id, { key: 'a', label: 'a', settings: {} }), 'duplicate');
    assert.equal(queue.jobs[1].state, 'editing');
  });

  it('puts a job back unchanged when an edit is discarded', async () => {
    const { queue } = loadQueue();
    const a = job('a'), b = job('b', { level: 5 });
    queue.add(a);
    queue.add(b);
    queue.startEditing(queue.jobs[1].id);
    queue.cancelEditing(queue.jobs[1].id);
    await tick();
    a.finish();
    await tick();
    assert.deepEqual(b.seenSettings, { level: 5 });
  });

  it('tells listeners about every change', async () => {
    const { queue } = loadQueue();
    let calls = 0;
    queue.subscribe(() => calls++);
    const a = job('a');
    queue.add(a);
    await tick();
    a.finish();
    await tick();
    assert.ok(calls >= 3, `expected at least add, start and finish; got ${calls}`);
  });

  it('clears finished jobs on request, leaving active ones', async () => {
    const { queue } = loadQueue();
    const a = job('a'), b = job('b');
    queue.add(a);
    queue.add(b);
    await tick();
    a.finish();
    await tick();
    queue.clearFinished();
    assert.deepEqual(states(queue), ['b:running']);
  });
});
