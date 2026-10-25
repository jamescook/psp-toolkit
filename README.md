# PSP Toolkit

**[jamescook.github.io/psp-toolkit](https://jamescook.github.io/psp-toolkit/)** — use it online, no download needed. Auto-deployed from `main` on every push, so it's always the latest build.

Browser-based tool for converting and patching PSP and PS1 disc images, and
converting PS1 saves. Everything runs client-side — no server, no uploads,
your files never leave your machine.

## Features

### CSO / ZSO / ISO Conversion
Drop a PSP disc image and convert between formats:
- **CSO** — deflate-compressed (smaller but slower to load on PSP)
- **ZSO** — LZ4-compressed (slightly larger but much faster on PSP hardware)
- **ISO** — uncompressed (largest, no decompression overhead)

All 6 conversion paths work: CSO↔ISO, ZSO↔ISO, CSO↔ZSO.

### PS1 → EBOOT.PBP
Drop a PS1 disc image (.bin/.iso, with or without .cue) and build a PSP-compatible EBOOT.PBP:
- Auto-detects disc ID from SYSTEM.CNF and title from ISO volume ID (falls back to filename)
- Multi-disc support (up to 5 discs)
- CUE/BIN pairing — drop CUE+BIN files together, or CUEs first then BINs
- Configurable compression level (0–9)
- Custom artwork — click ICON0/PIC0/PIC1 previews to upload your own images, or use auto-generated title art
- Optional artwork auto-fetch from a community covers database when a disc ID is detected (requires network, off by default)
- Tested on PSP-3000 with ARK-4 custom firmware

### Patch
Apply IPS, PPF (v1–v3), BPS, and xdelta/VCDIFF patches to a disc image:
- Multi-disc sets — drop each disc and its patch; the patched discs download as one ZIP
- Checks what the format allows: PPF block check, BPS source/target CRC32s

### Save Manager
Convert PS1 memory card saves between PC emulators and PSP/Vita:
- DexDrive `.gme` or raw `.mcr`/`.mcd` card → signed `.VMP` for PSP/Vita
- PSP/Vita `.VMP` → raw `.mcr` or DexDrive `.gme`
- Pick saves from the card; several at once download as a ZIP already laid out as `PSP/SAVEDATA/<game>/`

### Diagnose
Drop any file to see what it is: EBOOT.PBP (header, PARAM.SFO, PSAR), CSO/ZSO,
BIN/ISO, CUE, every patch format above, and GME/MCR/VMP memory cards (each
save's product code, and whether a VMP's signature is valid). Unknown files
get a hex dump.

### Queue
Line up to 10 jobs from any tab — several discs to convert, EBOOTs to build,
patches to apply — and they run one after another while you set up the next.
Each file is saved as soon as its job finishes. A tray along the bottom shows
progress; edit or remove a waiting job, or cancel the running one. In Chrome
and Edge you can pick a folder once and every file is written straight into it.

## Usage

Just open **[jamescook.github.io/psp-toolkit](https://jamescook.github.io/psp-toolkit/)**.

For an offline copy, download `index.html` from the [latest release](../../releases/latest) instead — single file, no install, no server.

### Building from source

```sh
npm install
node build.js
open dist/index.html
```

### Testing

```sh
npm test                    # Unit tests (node:test)
npm run test:e2e            # Playwright E2E tests (local Chromium, Firefox, WebKit)
npm run test:e2e:docker     # E2E tests in Docker (matches CI)
npm run test:e2e:update     # Update screenshot baselines
```

## How It Works

- **Web Workers** handle all compression off the main thread so the UI stays
  responsive even with 1GB+ files
- **pako 2.1.0** for deflateRaw and inflateRaw
- **LZ4** block compress/decompress implemented from scratch in JS
- PS1 EBOOT construction follows the PSISOIMG0000 format: each 0x9300-byte
  block of the disc image is independently deflate-compressed, with an index
  table for random access

## File Structure

```
app.html                — Main HTML shell
style.css               — Dark theme styles
build.js                — Produces dist/index.html (single-file build, workers inlined)
*worker.js              — Web Workers, one per kind of job:
  worker.js             —   CSO/ZSO/ISO conversion
  cso-compress-worker.js —  parallel CSO/ZSO compression
  eboot-worker.js       —   EBOOT.PBP construction
  compress-worker.js    —   parallel EBOOT compression
  patch-worker.js       —   applying patches
  save-worker.js        —   packaging one save as VMP/MCR/GME
  zip-worker.js         —   building download ZIPs
remote-file.js          — Lets a worker read a dropped file through the page (Safari offline)
read-blocks.js          — Reads a range of disc blocks in ~4 MB batches, for the parallel compressors
Dockerfile.test         — Docker image for CI/E2E tests
playwright.config.js    — Playwright E2E config
ui/                     — One script per tab, plus shared helpers (plain globals, no modules)
  run-worker.js         — Runs a job on a worker, or across a pool of them
  job-queue.js          — The queue: one job at a time, duplicates ignored, editable while waiting
  queue-tray.js         — The queue tray along the bottom, and how tabs hand it jobs
  save-output.js        — Saves finished files into a chosen folder, or downloads them
  shared.js             — Shared utilities, disc detection, CUE parsing, tab switching
  convert.js            — Convert tab
  eboot-ui.js           — EBOOT tab
  artwork.js            — Default EBOOT artwork (ICON0/PIC0/PIC1)
  artwork-fetch.js      — Opt-in cover fetch by disc ID
  diagnose.js           — Diagnose tab
  patch.js              — Patch tab
  save-manager.js       — Save Manager tab
cso/                    — CSO/ZSO header and conversion, LZ4
eboot/                  — EBOOT.PBP construction (PBP, PARAM.SFO, PSAR, TOC, CUE, disc ID)
patch/                  — IPS, PPF, BPS, and VCDIFF/xdelta (with XZ/LZMA2/LZMA decoders)
save/                   — PS1 memory card (MCR) parser, GME container, VMP writer, AES-128
vendor/                 — pako 2.1.0 (deflateRaw/inflateRaw), xdelta3
docs/                   — Format references: eboot-format.md, save-format.md
test/                   — Unit tests (node:test); e2e/ holds the Playwright tests per tab
scripts/                — Fixture generators, the Docker test runner, the VMP oracle check
tools/                  — Debugging: inspect-eboot.js, debug-vcdiff.js
```

## Prior Art

This project's EBOOT format implementation is informed by several open-source
projects. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

## License

MIT
