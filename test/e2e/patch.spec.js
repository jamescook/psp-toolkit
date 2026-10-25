import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectSaved, expectFailed } from './queue-helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const ROM_PATH = path.join(FIXTURES, 'patch-test.bin');
const PATCH_PATH = path.join(FIXTURES, 'patch-test.ips');
const LARGE_ROM_PATH = path.join(FIXTURES, 'patch-test-large.bin');
const PPF_BC_PATH = path.join(FIXTURES, 'patch-test-blockcheck.ppf');
const XDELTA_PATH = path.join(FIXTURES, 'patch-test.xdelta');

// Multi-window VCDIFF fixtures (1MB, 32 windows, LZMA secondary compression)
const VCDIFF_MULTI_SOURCE = path.join(FIXTURES, 'vcdiff-multi-source.bin');
const VCDIFF_MULTI_LZMA = path.join(FIXTURES, 'vcdiff-multi-lzma.xdelta');

// Multi-disc fixtures
const DISC1_ROM = path.join(FIXTURES, 'patch-disc1.bin');
const DISC2_ROM = path.join(FIXTURES, 'patch-disc2.bin');
const DISC3_ROM = path.join(FIXTURES, 'patch-disc3.bin');
const DISC1_PATCH = path.join(FIXTURES, 'patch-disc1.xdelta');
const DISC2_PATCH = path.join(FIXTURES, 'patch-disc2.xdelta');
const DISC3_PATCH = path.join(FIXTURES, 'patch-disc3.xdelta');

test.beforeEach(async ({ page }) => {
  await page.goto('index.html');
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await page.evaluate(() => {
    let t = 0;
    performance.now = () => (t += 100);
  });

  await page.locator('.tab-btn[data-tab="patch"]').click();
});

test('initial state: button disabled, both slots empty', async ({ page }) => {
  const btn = page.locator('[data-testid="apply-patch"]');
  await expect(btn).toBeVisible();
  await expect(btn).toBeDisabled();
  await expect(page.locator('[data-testid="patch-rom-slot"]')).not.toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-patch-slot"]')).not.toHaveClass(/filled/);
  await expect(page).toHaveScreenshot('patch-initial.png');
});

test('upload ROM only: button stays disabled, ROM slot filled', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles(ROM_PATH);

  await expect(page.locator('[data-testid="patch-rom-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-patch-slot"]')).not.toHaveClass(/filled/);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeDisabled();
  await expect(page).toHaveScreenshot('patch-rom-only.png');
});

test('upload patch only: button stays disabled, patch slot filled', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles(PATCH_PATH);

  await expect(page.locator('[data-testid="patch-patch-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-rom-slot"]')).not.toHaveClass(/filled/);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeDisabled();
  await expect(page).toHaveScreenshot('patch-patch-only.png');
});

test('upload both together: button enabled, apply and download', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles([ROM_PATH, PATCH_PATH]);

  await expect(page.locator('[data-testid="patch-rom-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-patch-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();
  await expect(page).toHaveScreenshot('patch-both-staged.png');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="apply-patch"]').click(),
  ]);

  const downloadPath = await download.path();
  const result = new Uint8Array(fs.readFileSync(downloadPath));

  expect(result[0x100]).toBe(0xDE);
  expect(result[0x101]).toBe(0xAD);
  expect(result[0x102]).toBe(0xBE);
  expect(result[0x103]).toBe(0xEF);
  expect(result[0]).toBe(0x00);
  expect(result[1]).toBe(0x01);

  await expectSaved(page, 'patch-test (patched).bin');
  await expect(page).toHaveScreenshot('patch-applied.png');
});

test('upload ROM then patch separately: button enables after second', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles(ROM_PATH);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeDisabled();

  await page.locator('[data-testid="patch-file-input"]').setInputFiles(PATCH_PATH);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();
  await expect(page).toHaveScreenshot('patch-sequential-upload.png');
});

test('upload patch then ROM separately: button enables after second', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles(PATCH_PATH);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeDisabled();

  await page.locator('[data-testid="patch-file-input"]').setInputFiles(ROM_PATH);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();
});

test('CUE file rejected with message', async ({ page }) => {
  // Create a temp .cue file
  const cuePath = path.join(FIXTURES, 'temp-test.cue');
  fs.writeFileSync(cuePath, 'FILE "test.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n');
  try {
    await page.locator('[data-testid="patch-file-input"]').setInputFiles(cuePath);
    await expect(page.locator('[data-testid="patch-status"]')).toContainText('CUE files are not supported');
  } finally {
    fs.unlinkSync(cuePath);
  }
});

test('unrecognized file type rejected', async ({ page }) => {
  const txtPath = path.join(FIXTURES, 'temp-test.txt');
  fs.writeFileSync(txtPath, 'hello');
  try {
    await page.locator('[data-testid="patch-file-input"]').setInputFiles(txtPath);
    await expect(page.locator('[data-testid="patch-status"]')).toContainText('Unrecognized file type');
  } finally {
    fs.unlinkSync(txtPath);
  }
});

test('PPF block check passes with correct source image', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles([LARGE_ROM_PATH, PPF_BC_PATH]);

  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="apply-patch"]').click(),
  ]);

  const downloadPath = await download.path();
  const result = new Uint8Array(fs.readFileSync(downloadPath));

  // PPF patch writes [0xCA, 0xFE] at offset 0x10
  expect(result[0x10]).toBe(0xCA);
  expect(result[0x11]).toBe(0xFE);

  await expectSaved(page, 'patch-test-large (patched).bin');
});

test('PPF block check fails with wrong source image', async ({ page }) => {
  // Use the small 1KB ROM (wrong source) with the block-check PPF
  await page.locator('[data-testid="patch-file-input"]').setInputFiles([ROM_PATH, PPF_BC_PATH]);

  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();
  await page.locator('[data-testid="apply-patch"]').click();

  expect(await expectFailed(page)).toContain('block check failed');
});

test('xdelta patch: upload ROM + .xdelta → verify patched output', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles([ROM_PATH, XDELTA_PATH]);

  await expect(page.locator('[data-testid="patch-rom-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-patch-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="apply-patch"]').click(),
  ]);

  const downloadPath = await download.path();
  const result = new Uint8Array(fs.readFileSync(downloadPath));

  // xdelta fixture writes [0xDE, 0xAD, 0xBE, 0xEF] at offset 0x80
  expect(result[0x80]).toBe(0xDE);
  expect(result[0x81]).toBe(0xAD);
  expect(result[0x82]).toBe(0xBE);
  expect(result[0x83]).toBe(0xEF);
  // Rest unchanged
  expect(result[0]).toBe(0x00);
  expect(result[1]).toBe(0x01);

  await expectSaved(page, 'patch-test (patched).bin');
  await expectSaved(page, 'XDELTA patch applied');
});

test('xdelta multi-window LZMA: 1MB ROM + 32-window patch completes without error', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles([VCDIFF_MULTI_SOURCE, VCDIFF_MULTI_LZMA]);

  await expect(page.locator('[data-testid="patch-rom-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-patch-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="apply-patch"]').click(),
  ]);

  await expectSaved(page, 'vcdiff-multi-source (patched).bin');
  await expectSaved(page, 'XDELTA patch applied');
  expect(download.suggestedFilename()).toMatch(/patched/);
});

test('multi-disc: upload 3 ROMs + 3 patches → single ZIP download with correct content', async ({ page }) => {
  // Upload all 6 files at once
  await page.locator('[data-testid="patch-file-input"]').setInputFiles([
    DISC1_ROM, DISC2_ROM, DISC3_ROM,
    DISC1_PATCH, DISC2_PATCH, DISC3_PATCH,
  ]);

  await expect(page.locator('[data-testid="patch-rom-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-patch-slot"]')).toHaveClass(/filled/);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();

  // Should show file lists with 3 items each
  await expect(page.locator('[data-testid="patch-rom-list"] [data-testid="patch-file-item"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="patch-patch-list"] [data-testid="patch-file-item"]')).toHaveCount(3);

  // Collect download (single ZIP)
  const downloadPromise = page.waitForEvent('download');

  await page.locator('[data-testid="apply-patch"]').click();
  await expectSaved(page, '3 patches applied');

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  // Read ZIP and extract entries (stored/uncompressed ZIP format)
  const zipBytes = new Uint8Array(fs.readFileSync(await download.path()));
  const entries = [];
  let off = 0;
  while (off < zipBytes.length) {
    const sig = zipBytes[off] | (zipBytes[off+1] << 8) | (zipBytes[off+2] << 16) | (zipBytes[off+3] << 24);
    if (sig !== 0x04034B50) break; // Not a local file header
    const nameLen = zipBytes[off+26] | (zipBytes[off+27] << 8);
    const extraLen = zipBytes[off+28] | (zipBytes[off+29] << 8);
    const compSize = zipBytes[off+18] | (zipBytes[off+19] << 8) | (zipBytes[off+20] << 16) | (zipBytes[off+21] << 24);
    const name = new TextDecoder().decode(zipBytes.slice(off+30, off+30+nameLen));
    const data = zipBytes.slice(off+30+nameLen+extraLen, off+30+nameLen+extraLen+compSize);
    entries.push({ name, data });
    off += 30 + nameLen + extraLen + compSize;
  }

  expect(entries.length).toBe(3);

  // Verify each entry has correct patched bytes
  const expected = [
    { fill: 0x11, patchBytes: [0xAA, 0xBB] },
    { fill: 0x22, patchBytes: [0xCC, 0xDD] },
    { fill: 0x33, patchBytes: [0xEE, 0xFF] },
  ];

  for (let i = 0; i < 3; i++) {
    const result = entries[i].data;
    expect(result[0x40]).toBe(expected[i].patchBytes[0]);
    expect(result[0x41]).toBe(expected[i].patchBytes[1]);
    expect(result[0]).toBe(expected[i].fill);
  }
});

test('clear button resets all files', async ({ page }) => {
  await page.locator('[data-testid="patch-file-input"]').setInputFiles([ROM_PATH, PATCH_PATH]);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeEnabled();
  await expect(page.locator('[data-testid="patch-clear"]')).toBeVisible();

  await page.locator('[data-testid="patch-clear"]').click();

  await expect(page.locator('[data-testid="patch-rom-slot"]')).not.toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-patch-slot"]')).not.toHaveClass(/filled/);
  await expect(page.locator('[data-testid="apply-patch"]')).toBeDisabled();
});
