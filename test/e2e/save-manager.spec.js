import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_HTML = path.join(ROOT, 'dist', 'index.html');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const SAVE_GME = path.join(FIXTURES, 'save-test.gme');

const VMP_SIZE = 0x20080;
const VMP_HEADER_BYTES = [0x00, 0x50, 0x4d, 0x56, 0x80];

function fileUrl(p) {
  return 'file://' + p;
}

/** Minimal ZIP reader (stored/uncompressed entries), matching patch.spec.js's approach. */
function readZipEntries(zipBytes) {
  const entries = [];
  let off = 0;
  while (off < zipBytes.length) {
    const sig = zipBytes[off] | (zipBytes[off+1] << 8) | (zipBytes[off+2] << 16) | (zipBytes[off+3] << 24);
    if (sig !== 0x04034B50) break; // not a local file header
    const nameLen = zipBytes[off+26] | (zipBytes[off+27] << 8);
    const extraLen = zipBytes[off+28] | (zipBytes[off+29] << 8);
    const compSize = zipBytes[off+18] | (zipBytes[off+19] << 8) | (zipBytes[off+20] << 16) | (zipBytes[off+21] << 24);
    const name = new TextDecoder().decode(zipBytes.slice(off+30, off+30+nameLen));
    const data = zipBytes.slice(off+30+nameLen+extraLen, off+30+nameLen+extraLen+compSize);
    entries.push({ name, data });
    off += 30 + nameLen + extraLen + compSize;
  }
  return entries;
}

function expectVmpBytes(bytes) {
  expect(bytes.length).toBe(VMP_SIZE);
  expect([...bytes.slice(0, 5)]).toEqual(VMP_HEADER_BYTES);
}

test.beforeEach(async ({ page }) => {
  await page.goto(fileUrl(DIST_HTML));
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await page.locator('.tab-btn[data-tab="save"]').click();
});

test('initial state: drop zone visible, no slot controls yet', async ({ page }) => {
  await expect(page.locator('[data-testid="save-drop-zone"]')).toBeVisible();
  await expect(page.locator('[data-testid="save-extract-btn"]')).toBeDisabled();
  await expect(page.locator('[data-testid="save-slot-item"]')).toHaveCount(0);
});

test('drop a .gme: lists both real saves and shows the placement info box', async ({ page }) => {
  await page.locator('[data-testid="save-file-input"]').setInputFiles(SAVE_GME);

  await expect(page.locator('[data-testid="save-slot-item"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="save-info-box"]')).toBeVisible();
  await expect(page.locator('[data-testid="save-info-box"]')).toContainText('PSP/SAVEDATA');

  const meta = page.locator('#saveFileMeta');
  await expect(meta).toContainText('GME');
});

test('select all: selection count and button label update', async ({ page }) => {
  await page.locator('[data-testid="save-file-input"]').setInputFiles(SAVE_GME);
  await expect(page.locator('[data-testid="save-slot-item"]')).toHaveCount(2);

  await expect(page.locator('#saveSlotCount')).toContainText('0 of 2 selected');

  await page.locator('[data-testid="save-select-all-btn"]').click();
  await expect(page.locator('#saveSlotCount')).toContainText('2 of 2 selected');
  await expect(page.locator('[data-testid="save-extract-btn"]')).toHaveText(/2 Saves \(ZIP\)/);

  await page.locator('[data-testid="save-select-all-btn"]').click();
  await expect(page.locator('#saveSlotCount')).toContainText('0 of 2 selected');
});

test('single save: extract downloads one valid .vmp', async ({ page }) => {
  await page.locator('[data-testid="save-file-input"]').setInputFiles(SAVE_GME);
  await expect(page.locator('[data-testid="save-slot-item"]')).toHaveCount(2);

  // Select just the single-block save (SLUS-99999).
  await page.locator('[data-testid="save-slot-item"]', { hasText: 'SLUS-99999' })
    .locator('input[type="checkbox"]').check();
  await expect(page.locator('[data-testid="save-extract-btn"]')).toHaveText('Extract to VMP');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="save-extract-btn"]').click(),
  ]);

  await expect(page.locator('[data-testid="save-status"]')).toContainText('Done', { timeout: 10000 });
  expect(download.suggestedFilename()).toMatch(/SLUS99999.*SCEVMC0\.VMP$/);

  const vmpBytes = new Uint8Array(fs.readFileSync(await download.path()));
  expectVmpBytes(vmpBytes);
});

test('multiple saves: extract downloads a ZIP with both saves at the correct POPS paths', async ({ page }) => {
  await page.locator('[data-testid="save-file-input"]').setInputFiles(SAVE_GME);
  await expect(page.locator('[data-testid="save-slot-item"]')).toHaveCount(2);

  await page.locator('[data-testid="save-select-all-btn"]').click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="save-extract-btn"]').click(),
  ]);

  await expect(page.locator('[data-testid="save-status"]')).toContainText('2 saves extracted', { timeout: 10000 });
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const zipBytes = new Uint8Array(fs.readFileSync(await download.path()));
  const entries = readZipEntries(zipBytes);
  expect(entries.length).toBe(2);

  const byName = Object.fromEntries(entries.map(e => [e.name, e.data]));
  expect(byName['PSP/SAVEDATA/SLUS99999/SCEVMC0.VMP']).toBeDefined();
  expect(byName['PSP/SAVEDATA/SCUS88888/SCEVMC0.VMP']).toBeDefined();
  expectVmpBytes(byName['PSP/SAVEDATA/SLUS99999/SCEVMC0.VMP']);
  expectVmpBytes(byName['PSP/SAVEDATA/SCUS88888/SCEVMC0.VMP']);
});

test('mobile viewport: drop, select, and extract remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });

  await expect(page.locator('[data-testid="save-drop-zone"]')).toBeVisible();

  await page.locator('[data-testid="save-file-input"]').setInputFiles(SAVE_GME);
  await expect(page.locator('[data-testid="save-slot-item"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="save-select-all-btn"]')).toBeVisible();

  await page.locator('[data-testid="save-select-all-btn"]').click();
  await expect(page.locator('[data-testid="save-extract-btn"]')).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="save-extract-btn"]').click(),
  ]);

  await expect(page.locator('[data-testid="save-status"]')).toContainText('extracted', { timeout: 10000 });
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
});
