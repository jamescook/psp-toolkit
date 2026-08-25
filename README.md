# PSP Toolkit

**[jamescook.github.io/psp-toolkit](https://jamescook.github.io/psp-toolkit/)** — use it online, no download needed. Auto-deployed from `main` on every push, so it's always the latest build.

Browser-based tool for converting PSP and PS1 disc images. Everything runs
client-side — no server, no uploads, your files never leave your machine.

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
npm run test:e2e            # Playwright E2E tests (local Chromium + Firefox)
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
build.js                — Produces dist/index.html (single-file build)
worker.js               — Web Worker for CSO/ZSO/ISO conversion
cso-compress-worker.js  — Web Worker for parallel CSO/ZSO compression
eboot-worker.js         — Web Worker for EBOOT.PBP construction
compress-worker.js      — Web Worker for parallel EBOOT compression
Dockerfile.test         — Docker image for CI/E2E tests
playwright.config.js    — Playwright E2E config
ui/
  artwork.js            — EBOOT artwork generation (ICON0/PIC0/PIC1)
  shared.js             — Shared utilities, disc detection, CUE parsing
  convert.js            — CSO/ZSO/ISO conversion UI
  eboot-ui.js           — EBOOT builder UI
  diagnose.js           — EBOOT diagnostic/inspection UI
eboot/
  assembler.js          — Orchestrates PBP construction
  pbp.js                — PBP container header writer
  sfo.js                — PARAM.SFO builder
  psisoimg.js           — Single-disc PSAR compression
  pstitleimg.js         — Multi-disc PSAR wrapper
  toc.js                — CD table of contents generator
  cue.js                — CUE sheet parser
  discid.js             — Disc ID auto-detection from ISO9660
  assets.js             — Static firmware blobs (DATA.PSP ELF, STARTDAT)
vendor/
  zlib.cjs              — deflateRaw + inflateRaw (pako 2.1.0, bundled by esbuild)
test/
  e2e/convert.spec.js   — Playwright E2E tests for convert tab
  fixtures/test.iso     — Shared synthetic ISO fixture (64KB)
scripts/
  generate-e2e-fixture.js   — Generates test/fixtures/test.iso
tools/
  inspect-eboot.js      — EBOOT structural inspector
```

## Prior Art

This project's EBOOT format implementation is informed by several open-source
projects. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

## License

MIT
