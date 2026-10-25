import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectSaved } from './queue-helpers.js';

// These tests keep a slow job running while they act on the ones behind it.
test.setTimeout(60000);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const FIXTURE_ISO = path.join(FIXTURES, 'test.iso');

const tray = (page) => page.locator('[data-testid="queue-tray"]');
const jobs = (page) => page.locator('[data-testid="queue-job"]');
/** The tray card for the job with this label (a file name or game title). */
const jobCard = (page, label) => jobs(page).filter({ hasText: label });

const SLOW_DISC_DIR = path.join(os.tmpdir(), 'psp-toolkit-queue-spec');

/**
 * The path of a disc big enough that compressing it with one worker takes a
 * few seconds. Written once, to a file: handing the browser a path is far
 * cheaper than pushing 24 MB through the test protocol on every use.
 */
function slowDisc(name = 'slow.iso') {
  const file = path.join(SLOW_DISC_DIR, name);
  if (!fs.existsSync(file)) {
    const buffer = Buffer.alloc(24 * 1024 * 1024);
    let seed = 7;
    for (let i = 0; i < buffer.length; i += 4) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      buffer.writeUInt32LE(seed, i);
    }
    fs.mkdirSync(SLOW_DISC_DIR, { recursive: true });
    // Write beside the target and rename, so a parallel worker never reads a half-written disc.
    const partial = `${file}.${process.pid}.partial`;
    fs.writeFileSync(partial, buffer);
    fs.renameSync(partial, file);
  }
  return file;
}

async function queueConversion(page, file, target = 'cso', workers = '1') {
  await page.locator('[data-testid="convert-file-input"]').setInputFiles(file);
  await page.locator('[data-testid="convert-threads"]').fill(workers);
  await page.locator(`[data-testid="convert-to-${target}"]`).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('index.html');
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
});

test('the tray is absent until a job is added', async ({ page }) => {
  await expect(tray(page)).toBeHidden();
  await page.locator('[data-testid="convert-file-input"]').setInputFiles(FIXTURE_ISO);
  await expect(tray(page)).toBeHidden();

  await page.locator('[data-testid="convert-to-cso"]').click();
  await expect(tray(page)).toBeVisible();
  await expect(page.locator('[data-testid="convert-status"]')).toHaveText('Added to the queue.');
});

test('two discs run one after the other, each saved as it finishes', async ({ page }) => {
  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));

  await queueConversion(page, slowDisc());
  await queueConversion(page, FIXTURE_ISO);
  await expect(jobs(page)).toHaveCount(2);
  await expect(jobCard(page, 'slow.iso')).toHaveAttribute('data-state', 'running');
  await expect(jobCard(page, 'test.iso')).toHaveAttribute('data-state', 'waiting');

  await expectSaved(page, 'slow.cso');
  await expectSaved(page, 'test.cso');
  // A download event can land just after the tray shows the job saved.
  await expect.poll(() => downloads).toEqual(['slow.cso', 'test.cso']);
  await expect(page.locator('[data-testid="queue-toggle"]')).toContainText('All done');
});

test('adding the same disc again does nothing', async ({ page }) => {
  await queueConversion(page, slowDisc());
  await page.locator('[data-testid="convert-to-cso"]').click();

  await expect(page.locator('[data-testid="convert-status"]')).toHaveText('Already in the queue.');
  await expect(jobs(page)).toHaveCount(1);
});

test('a waiting job can be removed, and the running one cancelled with nothing saved', async ({ page }) => {
  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));

  await queueConversion(page, slowDisc());
  await queueConversion(page, FIXTURE_ISO);
  await jobCard(page, 'test.iso').locator('[data-testid="queue-remove"]').click();
  await expect(jobs(page)).toHaveCount(1);

  await jobCard(page, 'slow.iso').locator('[data-testid="queue-cancel"]').click();
  const finished = page.locator('[data-testid="queue-finished"]');
  await expect(finished).toHaveAttribute('data-state', 'cancelled');
  await expect(page.locator('[data-testid="queue-toggle"]')).toContainText('All done');
  expect(downloads).toEqual([]);
});

test('Edit loads a waiting job back into its tab, and the changed settings are what runs', async ({ page }) => {
  await queueConversion(page, slowDisc());
  await queueConversion(page, FIXTURE_ISO);

  // Load something else into the tab first, so Edit visibly restores the job's disc.
  await page.locator('[data-testid="convert-file-input"]').setInputFiles(slowDisc('other.iso'));
  await jobCard(page, 'test.iso').locator('[data-testid="queue-edit"]').click();
  await expect(page.locator('#convertFileName')).toHaveText('test.iso');
  await expect(jobCard(page, 'test.iso')).toHaveAttribute('data-state', 'editing');
  await expect(page.locator('[data-testid="convert-to-zso"]')).toHaveText('Save changes: to ZSO');

  await page.locator('[data-testid="convert-to-zso"]').click();
  await expect(page.locator('[data-testid="convert-status"]')).toContainText('Changes saved');
  await expect(page.locator('[data-testid="convert-to-zso"]')).toHaveText('Convert to ZSO');

  await expectSaved(page, 'test.zso');
});

test('Edit on an EBOOT job restores its title and artwork, and builds with the changed title', async ({ page }) => {
  await queueConversion(page, slowDisc());

  await page.locator('[data-tab="eboot"]').click();
  await page.locator('[data-testid="eboot-file-input"]').setInputFiles(path.join(FIXTURES, 'ps1-disc1.bin'));
  await expect(page.locator('[data-testid="eboot-disc-id"]')).toHaveValue('SLUS00001', { timeout: 5000 });
  await expect(page.locator('#artIcon0')).toHaveAttribute('src', /.+/, { timeout: 5000 });
  await page.locator('#ebootThreads').fill('1');
  const queuedTitle = await page.locator('[data-testid="eboot-title"]').inputValue();
  await page.locator('[data-testid="eboot-build-btn"]').click();

  // The tab empties, ready for the next game; Edit brings back what was queued.
  await expect(page.locator('[data-testid="eboot-status"]')).toHaveText('Added to the queue.');
  await expect(page.locator('[data-testid="eboot-build-btn"]')).toHaveCount(0);
  await jobCard(page, queuedTitle).locator('[data-testid="queue-edit"]').click();
  await expect(page.locator('[data-testid="eboot-title"]')).toHaveValue(queuedTitle);
  await expect(page.locator('[data-testid="eboot-disc-id"]')).toHaveValue('SLUS00001');
  await expect(page.locator('#artIcon0')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('[data-testid="eboot-build-btn"]')).toHaveText('Save changes');

  await page.locator('[data-testid="eboot-title"]').fill('Renamed While Waiting');
  // The slow conversion ahead of it downloads first; wait for the EBOOT's ZIP.
  const [download] = await Promise.all([
    page.waitForEvent('download', { predicate: d => d.suggestedFilename().endsWith('.zip'), timeout: 60000 }),
    page.locator('[data-testid="eboot-build-btn"]').click(),
  ]);
  const zip = fs.readFileSync(await download.path());
  expect(zip.includes(Buffer.from('Renamed While Waiting'))).toBe(true);
});

test('Edit on a Save Manager job restores the ticked saves and format', async ({ page }) => {
  await queueConversion(page, slowDisc());

  await page.locator('[data-tab="save"]').click();
  await page.locator('[data-testid="save-file-input"]').setInputFiles(path.join(FIXTURES, 'save-test.vmp'));
  await page.locator('[data-testid="save-slot-item"]', { hasText: 'SLUS-99999' }).locator('input[type="checkbox"]').check();
  await page.locator('input[name="saveExportFormat"][value="gme"]').check();
  await page.locator('[data-testid="save-extract-btn"]').click();

  await page.locator('[data-testid="save-select-all-btn"]').click();
  await page.locator('input[name="saveExportFormat"][value="mcr"]').check();
  await jobCard(page, 'save-test.vmp').locator('[data-testid="queue-edit"]').click();

  const ticked = page.locator('[data-testid="save-slot-item"] input[type="checkbox"]:checked');
  await expect(ticked).toHaveCount(1);
  await expect(page.locator('[data-testid="save-slot-item"]', { hasText: 'SLUS-99999' }).locator('input')).toBeChecked();
  await expect(page.locator('input[name="saveExportFormat"][value="gme"]')).toBeChecked();
  await expect(page.locator('[data-testid="save-extract-btn"]')).toHaveText('Save changes');
});

test('after adding a patch job, the Patch tab is empty for the next disc', async ({ page }) => {
  await page.locator('[data-tab="patch"]').click();
  await page.locator('[data-testid="patch-file-input"]').setInputFiles([path.join(FIXTURES, 'patch-test.bin'), path.join(FIXTURES, 'patch-test.ips')]);
  await page.locator('[data-testid="apply-patch"]').click();

  await expect(page.locator('[data-testid="patch-status"]')).toHaveText('Added to the queue.');
  await expect(page.locator('[data-testid="patch-rom-slot"]')).not.toHaveClass(/filled/);
  await expect(page.locator('[data-testid="patch-patch-slot"]')).not.toHaveClass(/filled/);
  await expectSaved(page, 'patch-test (patched).bin');
});

test('a finished EBOOT build offers its build log from the tray', async ({ page }) => {
  await page.locator('[data-tab="eboot"]').click();
  await page.locator('[data-testid="eboot-file-input"]').setInputFiles(path.join(FIXTURES, 'ps1-disc1.bin'));
  await expect(page.locator('[data-testid="eboot-disc-id"]')).toHaveValue('SLUS00001', { timeout: 5000 });
  await page.locator('#ebootThreads').fill('1');
  await page.locator('[data-testid="eboot-build-btn"]').click();
  await expectSaved(page, 'SLUS00001.zip');

  // The ZIP's download event can land after the tray shows it saved; wait for the log's own.
  const [log] = await Promise.all([
    page.waitForEvent('download', { predicate: d => d.suggestedFilename().endsWith('.txt') }),
    page.locator('[data-testid="queue-attachment"]').click(),
  ]);
  expect(log.suggestedFilename()).toBe('eboot-build-log-SLUS00001.txt');
  expect(fs.readFileSync(await log.path(), 'utf8')).toContain('EBOOT Build Log');
});

test('Discard changes puts an edited job back as it was', async ({ page }) => {
  await queueConversion(page, slowDisc());
  await queueConversion(page, FIXTURE_ISO);
  await jobCard(page, 'test.iso').locator('[data-testid="queue-edit"]').click();
  await jobCard(page, 'test.iso').locator('[data-testid="queue-discard"]').click();

  await expect(page.locator('[data-testid="convert-to-cso"]')).toHaveText('Convert to CSO');
  await expectSaved(page, 'test.cso');
});

test('on a phone the tray starts folded and can be pulled up', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await queueConversion(page, slowDisc());

  const toggle = page.locator('[data-testid="queue-toggle"]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(jobs(page)).toHaveCount(0);

  await toggle.click();
  await expect(page.locator('[data-testid="queue-toggle"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(jobs(page)).toHaveCount(1);
});

test.describe('saving into a chosen folder', () => {
  test.beforeEach(async ({ page }) => {
    // Stand in for the browser's folder picker, which a test cannot click through.
    await page.addInitScript(() => {
      window.__written = {};
      const folder = {
        name: 'PSP games',
        async getFileHandle(name, { create = false } = {}) {
          if (!(name in window.__written) && !create) throw new DOMException('missing', 'NotFoundError');
          return {
            async createWritable() {
              const chunks = [];
              return {
                async write(data) { chunks.push(data); },
                async close() { window.__written[name] = chunks.reduce((n, c) => n + c.byteLength, 0); },
              };
            },
          };
        },
      };
      window.showDirectoryPicker = async () => folder;
    });
    await page.reload();
  });

  test('files go into the folder instead of downloading', async ({ page }) => {
    let downloaded = false;
    page.on('download', () => { downloaded = true; });

    await queueConversion(page, slowDisc());
    await page.locator('[data-testid="queue-choose-folder"]').click();
    await expect(page.locator('.queue-dest')).toContainText('Saving into “PSP games”');

    await expectSaved(page, 'slow.cso');
    const written = await page.evaluate(() => window.__written);
    expect(Object.keys(written)).toEqual(['slow.cso']);
    expect(written['slow.cso']).toBeGreaterThan(0);
    expect(downloaded).toBe(false);
  });
});
