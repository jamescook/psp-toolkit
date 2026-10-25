import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'save-output.js'), 'utf8');

function loadSaver(env) {
  const ctx = vm.createContext({ Promise, Error, Map });
  vm.runInContext(src, ctx);
  return ctx.createOutputSaver(env);
}

/** Stands in for a FileSystemDirectoryHandle: files are kept in a Map. */
class FakeFolder {
  constructor(name, existing = []) {
    this.name = name;
    this.files = new Map(existing.map(n => [n, new Uint8Array(0)]));
    this.failWrites = false;
  }
  async getFileHandle(fileName, { create = false } = {}) {
    if (!this.files.has(fileName) && !create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    const folder = this;
    return {
      async createWritable() {
        if (folder.failWrites) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        return {
          async write(data) { folder.files.set(fileName, data); },
          async close() {},
        };
      },
    };
  }
}

const output = (name) => ({ name, data: new Uint8Array([1, 2, 3]) });

describe('saving job outputs', () => {
  it('downloads each output when the browser cannot write to a folder', async () => {
    const downloads = [];
    const saver = loadSaver({ download: (data, name) => downloads.push(name) });
    assert.equal(saver.canChooseFolder, false);
    await saver.save([output('a.cso'), output('b.cso')]);
    assert.deepEqual(downloads, ['a.cso', 'b.cso']);
  });

  it('writes into the chosen folder instead of downloading', async () => {
    const downloads = [];
    const folder = new FakeFolder('PSP games');
    const saver = loadSaver({ download: (d, n) => downloads.push(n), showDirectoryPicker: async () => folder });
    assert.equal(saver.canChooseFolder, true);
    assert.equal(await saver.chooseFolder(), 'PSP games');
    assert.equal(saver.folderName, 'PSP games');

    await saver.save([output('a.cso')]);
    assert.deepEqual([...folder.files.keys()], ['a.cso']);
    assert.deepEqual([...folder.files.get('a.cso')], [1, 2, 3]);
    assert.equal(downloads.length, 0);
  });

  it('never overwrites a file already in the folder', async () => {
    const folder = new FakeFolder('out', ['Game.cso', 'Game (2).cso']);
    const saver = loadSaver({ download() {}, showDirectoryPicker: async () => folder });
    await saver.chooseFolder();
    await saver.save([output('Game.cso')]);
    assert.ok(folder.files.has('Game (3).cso'));
    assert.equal(folder.files.get('Game.cso').length, 0);
  });

  it('keeps downloading when the folder picker is closed without choosing', async () => {
    const downloads = [];
    const saver = loadSaver({
      download: (d, n) => downloads.push(n),
      showDirectoryPicker: async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }); },
    });
    assert.equal(await saver.chooseFolder(), null);
    assert.equal(saver.folderName, null);
    await saver.save([output('a.cso')]);
    assert.deepEqual(downloads, ['a.cso']);
  });

  it('falls back to downloading, and forgets the folder, when writing to it fails', async () => {
    const downloads = [];
    const folder = new FakeFolder('out');
    folder.failWrites = true;
    const saver = loadSaver({ download: (d, n) => downloads.push(n), showDirectoryPicker: async () => folder });
    await saver.chooseFolder();
    await saver.save([output('a.cso')]);
    assert.deepEqual(downloads, ['a.cso']);
    assert.equal(saver.folderName, null);
  });

  it('goes back to downloads when asked', async () => {
    const downloads = [];
    const saver = loadSaver({ download: (d, n) => downloads.push(n), showDirectoryPicker: async () => new FakeFolder('out') });
    await saver.chooseFolder();
    saver.useDownloads();
    await saver.save([output('a.cso')]);
    assert.deepEqual(downloads, ['a.cso']);
  });
});
