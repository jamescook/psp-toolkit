import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'artwork.js'), 'utf8');

function load() {
  const ctx = vm.createContext({ Math });
  vm.runInContext(src, ctx);
  return ctx;
}

// Rectangles are compared as plain arrays; values worked out by hand.
const rect = (r) => [r.x, r.y, r.w, r.h];

describe('containRect — the whole image, undistorted, centred', () => {
  it('a tall PSP cover (512x885) in ICON0 (144x80) is 46 wide, centred', () => {
    // 512 * 80/885 = 46.3 -> 46; (144 - 46) / 2 = 49
    assert.deepEqual(rect(load().containRect(512, 885, 144, 80)), [49, 0, 46, 80]);
  });

  it('a square PS1 cover (500x500) in ICON0 is 80x80, centred', () => {
    assert.deepEqual(rect(load().containRect(500, 500, 144, 80)), [32, 0, 80, 80]);
  });

  it('a very wide image fills the width and is centred vertically', () => {
    // 100 * 144/1000 = 14.4 -> 14; (80 - 14) / 2 = 33
    assert.deepEqual(rect(load().containRect(1000, 100, 144, 80)), [0, 33, 144, 14]);
  });
});

describe('coverRect — fills the whole slot, undistorted, centred, edges cropped', () => {
  it('a 4:3 screenshot (640x480) in PIC1 (480x272) overflows top and bottom equally', () => {
    // 480 * 480/640 = 360; (272 - 360) / 2 = -44
    assert.deepEqual(rect(load().coverRect(640, 480, 480, 272)), [0, -44, 480, 360]);
  });

  it('a square cover in ICON0 overflows top and bottom', () => {
    // 500 * 144/500 = 144; (80 - 144) / 2 = -32
    assert.deepEqual(rect(load().coverRect(500, 500, 144, 80)), [0, -32, 144, 144]);
  });
});
