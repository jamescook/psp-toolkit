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
  'ui/shared.js',
  'ui/artwork-fetch.js',
  'ui/convert.js',
  'ui/eboot-ui.js',
  'ui/diagnose.js',
  'ui/patch.js',
  'ui/save-manager.js',
];
const uiCode = uiPartials.map(read).join('\n');

// Bundle all workers with esbuild
const [csoWorkerCode, ebootWorkerCode, compressWorkerCode, csoCompressWorkerCode, patchWorkerCode, zipWorkerCode, saveWorkerCode] = await Promise.all([
  bundleWorker('worker.js', zlib, []),
  bundleWorker('eboot-worker.js', zlib, [inlineBlobsPlugin]),
  bundleWorker('compress-worker.js', zlib, [inlineBlobsPlugin]),
  bundleWorker('cso-compress-worker.js', zlib, []),
  bundleWorker('patch-worker.js', '', []),
  bundleWorker('zip-worker.js', '', []),
  bundleWorker('save-worker.js', '', []),
]);

// ── 1. Inline CSS (at the __STYLES__ marker) ─────────────────────────────────

html = replaceLiteral(html, '<!-- __STYLES__ -->', '<style>\n' + css + '\n</style>');

// ── 2. Inject worker code as globals (at the __WORKERS__ marker) ─────────────

const workerScript = '<script>\n' +
  'const __CSO_WORKER = `' + escapeForTemplateLiteral(csoWorkerCode) + '`;\n' +
  'const __EBOOT_WORKER = `' + escapeForTemplateLiteral(ebootWorkerCode) + '`;\n' +
  'const __COMPRESS_WORKER = `' + escapeForTemplateLiteral(compressWorkerCode) + '`;\n' +
  'const __CSO_COMPRESS_WORKER = `' + escapeForTemplateLiteral(csoCompressWorkerCode) + '`;\n' +
  'const __PATCH_WORKER = `' + escapeForTemplateLiteral(patchWorkerCode) + '`;\n' +
  'const __ZIP_WORKER = `' + escapeForTemplateLiteral(zipWorkerCode) + '`;\n' +
  'const __SAVE_WORKER = `' + escapeForTemplateLiteral(saveWorkerCode) + '`;\n' +
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

const workerReplacements = [
  ["new Worker('worker.js')", '__CSO_WORKER'],
  ["new Worker('eboot-worker.js')", '__EBOOT_WORKER'],
  ["new Worker('compress-worker.js')", '__COMPRESS_WORKER'],
  ["new Worker('cso-compress-worker.js')", '__CSO_COMPRESS_WORKER'],
  ["new Worker('patch-worker.js')", '__PATCH_WORKER'],
  ["new Worker('zip-worker.js')", '__ZIP_WORKER'],
  ["new Worker('save-worker.js')", '__SAVE_WORKER'],
];

for (const [original, global] of workerReplacements) {
  const blobExpr = `new Worker(URL.createObjectURL(new Blob([${global}], {type:'text/javascript'})))`;
  const before = html;
  html = html.replaceAll(original, blobExpr);
  if (html === before) throw new Error(`build.js: Worker string not found: ${original}`);
}

// ── 5. Write output ──────────────────────────────────────────────────────────

fs.mkdirSync(DIST, { recursive: true });
const outPath = path.join(DIST, 'index.html');
fs.writeFileSync(outPath, html);

const size = fs.statSync(outPath).size;
const kb = (size / 1024).toFixed(1);
console.log(`Built dist/index.html (${kb} KB)`);
