# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-10-25

### Changed

- Multi-worker CSO/ZSO and EBOOT compression read the disc in 4 MB batches inside each worker instead of the whole disc up front, 2 KB at a time: a 1.1 GB ISO converts in about 13 seconds instead of nearly 4 minutes, and the disc is never held in memory all at once

## [0.4.0] - 2026-10-25

### Added

- Job queue: Convert, EBOOT, Patch and Save Manager jobs line up (up to 10) and run one after another, each file saved as soon as its job finishes. A tray along the bottom shows progress; waiting jobs can be edited or removed and the running one cancelled. Adding the same job twice does nothing
- Chrome and Edge: choose a folder once and every finished file is written straight into it, instead of downloading

### Fixed

- Safari: converting, building an EBOOT, and patching work in the offline `index.html` opened from disk (they failed with "The I/O read operation failed")
- EBOOT tab: the file picker offers `.iso` disc images, which dropping already accepted
- PSP discs: the EBOOT and Diagnose tabs detect the disc ID (from `UMD_DATA.BIN`)

### Changed

- EBOOT artwork keeps its proportions: covers and title images are fitted whole over a blurred copy of themselves instead of stretched, and backgrounds are cropped to fill
- EBOOT tab refuses a PSP game: an EBOOT runs in the PSP's PS1 emulator, so a PSP game in one cannot start. It disables the controls and says to put the ISO or a CSO in the `ISO` folder instead

## [0.3.0] - 2026-10-25

### Added

- Save Manager tab for PS1 memory card saves
- Extract saves from a DexDrive `.gme` or raw `.mcr`/`.mcd` card to a signed `.VMP` for PSP/Vita
- Export saves from a PSP/Vita `.VMP` to a raw `.mcr` or a DexDrive `.gme` for PC emulators
- Several saves at once download as one ZIP, already laid out as `PSP/SAVEDATA/<game>/` for the memory stick
- Diagnose tab inspects GME, MCR, and VMP cards: lists each save with its product code, and checks a VMP's signature
- PS1 save format reference in `docs/save-format.md`, crediting apollo-psp and vita-mcr2vmp

### Fixed

- Multi-threaded CSO/ZSO and EBOOT compression, and EBOOT ZIP packaging, show an error instead of hanging when a worker fails

## [0.2.0] - 2026-03-18

### Added

- Patch tab for applying IPS, PPF, BPS, and xdelta/VCDIFF patches to disc images
- Multi-disc patch support — apply separate patches to each disc in a set
- Pure JS VCDIFF (RFC 3284) decoder with LZMA secondary compression support
- Pure JS XZ/LZMA2 decompressor for xdelta3 patches
- PPF v1/v2/v3 with block check validation
- BPS with full CRC32 validation (source, target, patch)
- Multi-file drag-and-drop with automatic ROM/patch classification
- Diagnose tab accepts any file type, not just EBOOT.PBP — inspectors for CSO, ZSO, BIN/ISO, CUE, IPS, PPF, BPS, and VCDIFF
- Deep patch inspection: IPS record counts and patched ranges, PPF version/block check/undo flags, BPS command breakdown and CRC32s, VCDIFF window count/sizes and secondary compression type
- Hex dump fallback for unknown file formats
- Format badge and one-line summary for all inspected files
- EBOOT results reorganized into Header/SFO/PSAR sub-tabs
- E2E Playwright tests for all patch formats and all diagnose inspectors
- MIT license

### Changed

- Larger fonts, wider layout, and more padding throughout the UI
- Table row striping and cleaner spacing in diagnose output

## [0.1.0] - 2026-03-07

### Added

- CSO/ZSO/ISO conversion with all 6 paths (CSO↔ISO, ZSO↔ISO, CSO↔ZSO)
- Multi-threaded compression via Web Workers
- PS1 EBOOT.PBP builder with PSISOIMG0000 format
- Multi-disc support (up to 5 discs) with PSTITLEIMG wrapper
- CUE/BIN pairing and auto-detection
- Disc ID auto-detection from SYSTEM.CNF
- Title auto-detection from ISO volume ID with filename fallback
- Configurable compression level (0–9)
- Custom artwork support (ICON0/PIC0/PIC1) with click-to-upload
- Auto-generated title artwork
- Optional artwork auto-fetch from community covers database
- Single-file production build (dist/index.html, no server needed)
- E2E tests with Playwright (Chromium + Firefox) and visual regression
- Docker-based CI test pipeline
