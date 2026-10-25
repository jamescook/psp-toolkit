import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_ISO = path.join(ROOT, 'test', 'fixtures', 'test.iso');

function md5(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

// Known-good MD5s of fixture and compressed outputs
const EXPECTED = {
  iso:        '1bdc9c004f09f2bac92d971b50d8a70a',
  cso:        'c1b78fef172850010932ff07842fdb73',
  zso:        '85fe38a650109e0f2cbd4d578237ed3c',
};

async function loadFile(page, filePath) {
  const input = page.locator('[data-testid="convert-file-input"]');
  await input.setInputFiles(filePath);
}

async function convertAndDownload(page, format) {
  const btn = page.locator(`[data-testid="convert-to-${format}"]`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    btn.click(),
  ]);
  const downloadPath = await download.path();
  return new Uint8Array(fs.readFileSync(downloadPath));
}

test.beforeEach(async ({ page }) => {
  await page.goto('index.html');
  // Kill all CSS transitions/animations so screenshots capture final state
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  // Stub performance.now() so elapsed time is always "0.1s" (deterministic screenshots)
  await page.evaluate(() => {
    let t = 0;
    performance.now = () => (t += 100);
  });
});

test('ISO → CSO (1 worker): compresses and downloads', async ({ page }) => {
  await expect(page).toHaveScreenshot('initial-load.png');

  await loadFile(page, FIXTURE_ISO);
  await expect(page).toHaveScreenshot('iso-selected.png');

  await page.locator('[data-testid="convert-threads"]').fill('1');
  await expect(page).toHaveScreenshot('slider-set-to-1.png');

  const csoBytes = await convertAndDownload(page, 'cso');
  await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');
  await expect(page).toHaveScreenshot('cso-1worker-done.png');

  expect(String.fromCharCode(...csoBytes.slice(0, 4))).toBe('CISO');
  expect(md5(csoBytes)).toBe(EXPECTED.cso);
});

test('ISO → CSO (2 workers): parallel path produces valid output', async ({ page }) => {
  await loadFile(page, FIXTURE_ISO);
  await expect(page.locator('[data-testid="convert-threads"]')).toHaveValue('2');
  await expect(page).toHaveScreenshot('iso-selected-2workers.png');

  const csoBytes = await convertAndDownload(page, 'cso');
  await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');
  await expect(page).toHaveScreenshot('cso-2workers-done.png');

  expect(String.fromCharCode(...csoBytes.slice(0, 4))).toBe('CISO');
  expect(md5(csoBytes)).toBe(EXPECTED.cso);
});

test('ISO → ZSO (2 workers): LZ4 parallel path', async ({ page }) => {
  await loadFile(page, FIXTURE_ISO);

  const zsoBytes = await convertAndDownload(page, 'zso');
  await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');
  await expect(page).toHaveScreenshot('zso-2workers-done.png');

  expect(String.fromCharCode(...zsoBytes.slice(0, 4))).toBe('ZISO');
  expect(md5(zsoBytes)).toBe(EXPECTED.zso);
});

test('Round-trip ISO → CSO → ISO (1 worker): byte-identical', async ({ page }) => {
  await loadFile(page, FIXTURE_ISO);
  await page.locator('[data-testid="convert-threads"]').fill('1');

  const csoBytes = await convertAndDownload(page, 'cso');
  await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');

  const tmpCso = path.join(ROOT, 'test', 'fixtures', 'tmp-roundtrip.cso');
  fs.writeFileSync(tmpCso, csoBytes);
  try {
    await loadFile(page, tmpCso);
    await expect(page).toHaveScreenshot('cso-loaded-for-roundtrip.png');

    const isoBytes = await convertAndDownload(page, 'iso');
    await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');
    await expect(page).toHaveScreenshot('roundtrip-cso-1worker-done.png');

    expect(md5(isoBytes)).toBe(EXPECTED.iso);
  } finally {
    fs.unlinkSync(tmpCso);
  }
});

test('Round-trip ISO → CSO → ISO (2 workers): byte-identical', async ({ page }) => {
  await loadFile(page, FIXTURE_ISO);

  const csoBytes = await convertAndDownload(page, 'cso');
  await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');

  const tmpCso = path.join(ROOT, 'test', 'fixtures', 'tmp-roundtrip.cso');
  fs.writeFileSync(tmpCso, csoBytes);
  try {
    await loadFile(page, tmpCso);
    const isoBytes = await convertAndDownload(page, 'iso');
    await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');
    await expect(page).toHaveScreenshot('roundtrip-cso-2workers-done.png');

    expect(md5(isoBytes)).toBe(EXPECTED.iso);
  } finally {
    fs.unlinkSync(tmpCso);
  }
});

test('Round-trip ISO → ZSO → ISO: byte-identical', async ({ page }) => {
  await loadFile(page, FIXTURE_ISO);

  const zsoBytes = await convertAndDownload(page, 'zso');
  await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');

  const tmpZso = path.join(ROOT, 'test', 'fixtures', 'tmp-roundtrip.zso');
  fs.writeFileSync(tmpZso, zsoBytes);
  try {
    await loadFile(page, tmpZso);
    const isoBytes = await convertAndDownload(page, 'iso');
    await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');
    await expect(page).toHaveScreenshot('roundtrip-zso-done.png');

    expect(md5(isoBytes)).toBe(EXPECTED.iso);
  } finally {
    fs.unlinkSync(tmpZso);
  }
});

test('Workers slider: visible for ISO, hidden for CSO/ZSO', async ({ page }) => {
  const opts = page.locator('[data-testid="convert-opts"]');

  await loadFile(page, FIXTURE_ISO);
  await expect(opts).toBeVisible();
  await expect(page).toHaveScreenshot('slider-visible-for-iso.png');

  const csoBytes = await convertAndDownload(page, 'cso');
  await expect(page.locator('[data-testid="convert-status"]')).toContainText('Done');

  const tmpCso = path.join(ROOT, 'test', 'fixtures', 'tmp-slider.cso');
  fs.writeFileSync(tmpCso, csoBytes);
  try {
    await loadFile(page, tmpCso);
    await expect(opts).toBeHidden();
    await expect(page).toHaveScreenshot('slider-hidden-for-cso.png');
  } finally {
    fs.unlinkSync(tmpCso);
  }
});
