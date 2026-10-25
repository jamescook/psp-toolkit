import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Tests open the page as page.goto('index.html'), resolved against each project's baseURL.
const DIST_FILE_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist') + path.sep).href;
const DIST_HTTP_PORT = 4173;

export default defineConfig({
  testDir: 'test/e2e',
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 500,
    },
  },
  webServer: {
    command: `node scripts/serve-dist.js ${DIST_HTTP_PORT}`,
    port: DIST_HTTP_PORT,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'chromium', use: {
      baseURL: DIST_FILE_URL,
      browserName: 'chromium',
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      launchOptions: {
        args: [
          '--font-render-hinting=none',
          '--disable-font-subpixel-positioning',
          '--disable-lcd-text',
          '--force-device-scale-factor=1',
        ],
      },
    } },
    { name: 'firefox', use: {
      baseURL: DIST_FILE_URL,
      browserName: 'firefox',
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    } },
    // WebKit is Safari's engine, built by Playwright: it stands in for Safari, not the Safari app.
    // It loads the page over http, as the website serves it: from file:// WebKit will not let a
    // worker read a dropped File, so converting, EBOOT builds and patching fail there.
    { name: 'webkit', use: {
      baseURL: `http://localhost:${DIST_HTTP_PORT}/`,
      browserName: 'webkit',
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    } },
  ],
});
