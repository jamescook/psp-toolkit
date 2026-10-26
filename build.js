#!/usr/bin/env node
// build.js — produces dist/index.html, a fully self-contained offline build
//
// Injection points in app.html:
//   <!-- __STYLES__ -->    — CSS gets inlined here
//   <!-- __WORKERS__ -->   — worker code globals get inlined here
//   <!-- __SCRIPTS__ -->   — zlib + UI partials get inlined here (replaces everything through </body>)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

// ── Helpers ──────────────────────────────────────────────────────────────────

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Escape code for safe embedding inside a JS template literal */
function escapeForTemplateLiteral(code) {
  return code
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/**
 * Replace a literal string in html exactly once. Throws if not found,
 * so we catch stale/broken replacements at build time instead of runtime.
 */
function replaceLiteral(html, target, replacement) {
  const idx = html.indexOf(target);
  if (idx === -1) throw new Error(`build.js: replacement target not found: ${JSON.stringify(target.slice(0, 80))}`);
  return html.slice(0, idx) + replacement + html.slice(idx + target.length);
}

/** Bundle a worker entry point with esbuild, prepending zlib */
async function bundleWorker(entryPoint, zlibCode, plugins) {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, entryPoint)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    banner: { js: zlibCode },
    plugins,
  });
  return result.outputFiles[0].text;
}

// ── esbuild plugin: inline .bin blobs into assets.js for browser builds ─────

const BLOB_FILES = ['datapsp.bin'];

const inlineBlobsPlugin = {
  name: 'inline-blobs',
  setup(build) {
    build.onLoad({ filter: /eboot\/assets\.js$/ }, () => {
      const blobData = {};
      for (const name of BLOB_FILES) {
        blobData[name] = fs.readFileSync(path.join(ROOT, 'eboot', 'blobs', name)).toString('base64');
      }
      const contents = `
function b64decode(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

const blobData = ${JSON.stringify(blobData)};
const blobs = {};
for (const [name, b64] of Object.entries(blobData)) blobs[name] = b64decode(b64);

export const ASSETS = {
  get dataPsp() { return new Uint8Array(blobs['datapsp.bin']); },
};
`;
      return { contents, loader: 'js' };
    });
  }
};

// ── Bundle zlib with esbuild (resolves vendor/pako/ requires into one IIFE) ──

async function bundleZlib({ minify = false } = {}) {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'vendor/zlib.cjs')],
    bundle: true,
    minify,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  return result.outputFiles[0].text;
}

// ── Read sources ─────────────────────────────────────────────────────────────

// Bundled+minified for dist, readable for local dev (vendor/zlib.browser.js)
const [zlib, zlibDev] = await Promise.all([
  bundleZlib({ minify: true }),
  bundleZlib({ minify: false }),
]);
fs.writeFileSync(path.join(ROOT, 'vendor/zlib.browser.js'), zlibDev);
const css = read('style.css');
let html = read('app.html');

// UI partials (loaded in order — each may reference globals from previous ones)
const uiPartials = [
  'ui/artwork.js',
  'ui/run-worker.js',
  'ui/drop-files.js',
  'ui/shared.js',
  'ui/save-output.js',
  'ui/job-queue.js',
  'ui/queue-tray.js',
  'ui/artwork-fetch.js',
  'ui/convert.js',
  'ui/eboot-ui.js',
  'ui/diagnose.js',
  'ui/patch.js',
  'ui/save-manager.js',
];
const uiCode = uiPartials.map(read).join('\n');

// The workers are whatever the UI starts: each literal new Worker('x.js') names
// one. A new worker needs no entry here unless it uses zlib or the .bin blobs.
const WORKER_CALL = /new Worker\('([\w.-]+\.js)'\)/g;
const workerFiles = [...new Set(Array.from(uiCode.matchAll(WORKER_CALL), m => m[1]))];
const workerCallCount = uiCode.split('new Worker(').length - 1;
if (workerCallCount !== Array.from(uiCode.matchAll(WORKER_CALL)).length) {
  throw new Error("build.js: every new Worker(...) in ui/ must take a literal file name, as new Worker('x.js')");
}

// Workers that need zlib's deflateRaw/inflateRaw globals, directly or through
// a module they import, and those that load eboot/assets.js.
const ZLIB_WORKERS = new Set(['worker.js', 'eboot-worker.js', 'compress-worker.js', 'cso-compress-worker.js']);
const BLOB_WORKERS = new Set(['eboot-worker.js', 'compress-worker.js']);

const workers = await Promise.all(workerFiles.map(async (file, i) => ({
  file,
  global: `__WORKER_${i}`,
  code: await bundleWorker(
    file,
    ZLIB_WORKERS.has(file) ? zlib : '',
    BLOB_WORKERS.has(file) ? [inlineBlobsPlugin] : [],
  ),
})));

// ── 1. Inline CSS (at the __STYLES__ marker) ─────────────────────────────────

html = replaceLiteral(html, '<!-- __STYLES__ -->', '<style>\n' + css + '\n</style>');

// ── 2. Inject worker code as globals (at the __WORKERS__ marker) ─────────────

const workerScript = '<script>\n' +
  workers.map(w => `const ${w.global} = \`${escapeForTemplateLiteral(w.code)}\`;\n`).join('') +
  '</script>';

html = replaceLiteral(html, '<!-- __WORKERS__ -->', workerScript);

// ── 3. Inline zlib + UI partials (at the __SCRIPTS__ marker) ─────────────────
// Replaces the marker and all <script src> tags with a single inlined block

const scriptsBlock = '<script>\n' + zlib + '\n' + uiCode + '\n</script>';
const scriptsStart = html.indexOf('<!-- __SCRIPTS__ -->');
const scriptsEnd = html.indexOf('</body>');
if (scriptsStart === -1) throw new Error('build.js: <!-- __SCRIPTS__ --> marker not found');
if (scriptsEnd === -1) throw new Error('build.js: </body> not found');
html = html.slice(0, scriptsStart) + scriptsBlock + '\n' + html.slice(scriptsEnd);

// ── 4. Replace new Worker(...) calls with blob URLs ──────────────────────────

for (const { file, global } of workers) {
  const blobExpr = `new Worker(URL.createObjectURL(new Blob([${global}], {type:'text/javascript'})))`;
  html = html.replaceAll(`new Worker('${file}')`, blobExpr);
}

// ── 5. Write output ──────────────────────────────────────────────────────────

fs.mkdirSync(DIST, { recursive: true });
const outPath = path.join(DIST, 'index.html');
fs.writeFileSync(outPath, html);

const size = fs.statSync(outPath).size;
const kb = (size / 1024).toFixed(1);
console.log(`Built dist/index.html (${kb} KB)`);
