import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectSaved } from './queue-helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

/** Wait for all artwork preview images to finish loading (if they have a src). */
async function waitForArtwork(page) {
  await page.evaluate(() => {
    const imgs = document.querySelectorAll('.art-preview');
    return Promise.all(Array.from(imgs).map(img => {
      if (!img.src) return Promise.resolve();
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(r => { img.onload = r; img.onerror = r; });
    }));
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('index.html');
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await page.evaluate(() => {
    let t = 0;
    performance.now = () => (t += 100);
  });
  // Switch to EBOOT tab
  await page.locator('[data-tab="eboot"]').click();
});

test('Multi-disc BIN drop → build EBOOT → download ZIP', async ({ page }) => {
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-tab-initial.png');

  const disc1Path = path.join(FIXTURES, 'ps1-disc1.bin');
  const disc2Path = path.join(FIXTURES, 'ps1-disc2.bin');

  // Drop both disc BINs at once
  const input = page.locator('[data-testid="eboot-file-input"]');
  await input.setInputFiles([disc1Path, disc2Path]);

  // Wait for auto-detection to populate disc ID and artwork to render
  await expect(page.locator('[data-testid="eboot-disc-id"]')).not.toHaveValue('', { timeout: 5000 });
  await expect(page.locator('#artIcon0')).toHaveAttribute('src', /.+/, { timeout: 5000 });
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-multi-disc-loaded.png');

  // Verify auto-detected disc ID and title
  const discId = await page.locator('[data-testid="eboot-disc-id"]').inputValue();
  expect(discId).toBe('SLUS00001');

  const title = await page.locator('[data-testid="eboot-title"]').inputValue();
  expect(title.toLowerCase()).toContain('test game');

  // Verify disc list shows 2 discs
  const discList = page.locator('[data-testid="eboot-disc-list"]');
  await expect(discList.locator('.disc-item')).toHaveCount(2);
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-disc-list-2discs.png');

  // Verify build button is visible
  const buildBtn = page.locator('[data-testid="eboot-build-btn"]');
  await expect(buildBtn).toBeVisible();

  // Set workers to 1 for deterministic output
  await page.locator('#ebootThreads').fill('1');

  // Click build and capture download
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    buildBtn.click(),
  ]);

  // Wait for completion
  await expectSaved(page, 'SLUS00001.zip');
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-multi-disc-build-done.png');

  // Verify download is a ZIP named after the disc ID
  expect(download.suggestedFilename()).toBe('SLUS00001.zip');

  // Read the ZIP and verify it contains an EBOOT.PBP
  const downloadPath = await download.path();
  const zipBytes = new Uint8Array(fs.readFileSync(downloadPath));
  // ZIP files start with PK\x03\x04
  expect(zipBytes[0]).toBe(0x50); // P
  expect(zipBytes[1]).toBe(0x4B); // K
  expect(zipBytes[2]).toBe(0x03);
  expect(zipBytes[3]).toBe(0x04);

  // The ZIP should contain SLUS00001/EBOOT.PBP — verify the filename appears in the ZIP
  const zipStr = new TextDecoder('ascii').decode(zipBytes);
  expect(zipStr).toContain('SLUS00001/EBOOT.PBP');

  // Verify the PBP inside starts with \0PBP magic
  // Find the PBP data after the local file header
  const pbpMagic = String.fromCharCode(0x00) + 'PBP';
  const pbpIdx = zipStr.indexOf(pbpMagic);
  expect(pbpIdx).toBeGreaterThan(0);
});

test('A PSP game is refused: the error says why, and every control is disabled', async ({ page }) => {
  const input = page.locator('[data-testid="eboot-file-input"]');
  await input.setInputFiles(path.join(FIXTURES, 'psp-disc.iso'));

  const status = page.locator('[data-testid="eboot-status"]');
  await expect(status).toContainText('PSP game', { timeout: 5000 });
  await expect(status).toHaveClass(/error/);
  await expect(page.locator('[data-testid="eboot-disc-id"]')).toHaveValue('ULUS10277');
  await expect(page.locator('[data-testid="eboot-build-btn"]')).toBeDisabled();
  for (const control of ['eboot-title', 'eboot-disc-id']) {
    await expect(page.locator(`[data-testid="${control}"]`)).toBeDisabled();
  }
  await expect(page.locator('#ebootCompression')).toBeDisabled();
  await expect(page.locator('#ebootThreads')).toBeDisabled();
  await expect(page.locator('#ebootFetchArt')).toBeDisabled();

  // A PS1 disc dropped next is accepted as normal.
  await input.setInputFiles(path.join(FIXTURES, 'ps1-disc1.bin'));
  await expect(page.locator('[data-testid="eboot-disc-id"]')).toHaveValue('SLUS00001', { timeout: 5000 });
  await expect(status).toHaveText('');
  await expect(page.locator('[data-testid="eboot-build-btn"]')).toBeEnabled();
  await expect(page.locator('[data-testid="eboot-title"]')).toBeEnabled();
});

test('The file picker offers .iso discs, as dropping does', async ({ page }) => {
  const accept = await page.locator('[data-testid="eboot-file-input"]').getAttribute('accept');
  expect(accept.split(',')).toEqual(expect.arrayContaining(['.bin', '.iso', '.cue']));
});

test('Building with 2 workers produces the same EBOOT as with 1', async ({ page }) => {
  const input = page.locator('[data-testid="eboot-file-input"]');

  let builds = 0;
  async function buildWith(workers) {
    // The tab empties once a build is queued, so drop the disc each time.
    await input.setInputFiles([path.join(FIXTURES, 'ps1-disc1.bin')]);
    await expect(page.locator('[data-testid="eboot-disc-id"]')).not.toHaveValue('', { timeout: 5000 });
    await expect(page.locator('#artIcon0')).toHaveAttribute('src', /.+/, { timeout: 5000 });
    await page.locator('#ebootThreads').fill(String(workers));
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.locator('[data-testid="eboot-build-btn"]').click(),
    ]);
    // The same discs can be queued again only once the earlier build has finished.
    builds++;
    await expect(page.locator('[data-testid="queue-finished"][data-state="done"]')).toHaveCount(builds, { timeout: 60000 });
    return fs.readFileSync(await download.path());
  }

  // The ZIP is stored (uncompressed) with no timestamps, so equal ZIPs mean equal EBOOTs.
  const oneWorker = await buildWith(1);
  const twoWorkers = await buildWith(2);
  expect(twoWorkers.length).toBe(oneWorker.length);
  expect(twoWorkers.equals(oneWorker)).toBe(true);
});

test('Single disc with CUE+BIN → build EBOOT', async ({ page }) => {
  const disc1Bin = path.join(FIXTURES, 'ps1-disc1.bin');
  const disc1Cue = path.join(FIXTURES, 'ps1-disc1.cue');

  // Drop CUE and BIN together
  const input = page.locator('[data-testid="eboot-file-input"]');
  await input.setInputFiles([disc1Cue, disc1Bin]);

  // Wait for auto-detection and artwork to render
  await expect(page.locator('[data-testid="eboot-disc-id"]')).not.toHaveValue('', { timeout: 5000 });
  await expect(page.locator('#artIcon0')).toHaveAttribute('src', /.+/, { timeout: 5000 });
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-cue-bin-loaded.png');

  const discId = await page.locator('[data-testid="eboot-disc-id"]').inputValue();
  expect(discId).toBe('SLUS00001');

  // Build
  await page.locator('#ebootThreads').fill('1');
  const buildBtn = page.locator('[data-testid="eboot-build-btn"]');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    buildBtn.click(),
  ]);

  await expectSaved(page, 'SLUS00001.zip');
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-cue-bin-build-done.png');

  expect(download.suggestedFilename()).toBe('SLUS00001.zip');
});
