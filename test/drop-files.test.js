import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'drop-files.js'), 'utf8');

function loadCollector() {
  const ctx = vm.createContext({ Promise, Error, Array });
  vm.runInContext(src, ctx);
  return ctx.collectDroppedFiles;
}

// Stand-ins for the browser's FileSystemEntry objects a drop hands over.
const fileEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok({ name }) });
function dirEntry(name, children) {
  return {
    isFile: false, isDirectory: true, name,
    // readEntries hands back entries in batches, then an empty batch at the end.
    createReader() {
      const batches = [children.slice(0, 2), children.slice(2), []];
      return { readEntries: (ok) => ok(batches.shift()) };
    },
  };
}
/** A drop as the browser hands it over: an entry per item, and `files` listing the loose files. */
function dropOf(entries) {
  return {
    items: entries.map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    files: entries.filter(entry => entry.isFile).map(entry => ({ name: entry.name, loose: true })),
  };
}
const names = (files) => Array.from(files, f => f.name);

describe('collectDroppedFiles', () => {
  it('reads the files inside a dropped folder, including subfolders, keeping only accepted types', async () => {
    const collect = loadCollector();
    const drop = dropOf([dirEntry('Metal Slug X (USA)', [
      fileEntry("Vimm's Lair.txt"),
      dirEntry('Metal Slug X (USA)', [fileEntry('Metal Slug X (USA).bin'), fileEntry('Metal Slug X (USA).cue')]),
      fileEntry('.DS_Store'),
    ])]);

    assert.deepEqual(names(await collect(drop, '.bin,.iso,.img,.cue')), ['Metal Slug X (USA).bin', 'Metal Slug X (USA).cue']);
  });

  it('passes loose files through untouched, whatever their type, so the tab can say what is wrong', async () => {
    const collect = loadCollector();
    const drop = dropOf([fileEntry('notes.txt'), fileEntry('game.iso')]);
    const files = await collect(drop, '.iso');

    assert.deepEqual(names(files), ['notes.txt', 'game.iso']);
    // Taken from the plain file list, which WebKit can read where it cannot read the entry.
    assert.deepEqual(Array.from(files, f => f.loose), [true, true]);
  });

  it('falls back to the plain file list when the browser gives no entries', async () => {
    const collect = loadCollector();
    const loose = [{ name: 'game.iso' }];

    assert.deepEqual(names(await collect({ items: [], files: loose }, '.iso')), ['game.iso']);
  });

  it('matches accepted types without regard to case', async () => {
    const collect = loadCollector();
    const drop = dropOf([dirEntry('GAME', [fileEntry('GAME.BIN'), fileEntry('game.Cue')])]);

    assert.deepEqual(names(await collect(drop, '.bin,.cue')), ['GAME.BIN', 'game.Cue']);
  });
});
