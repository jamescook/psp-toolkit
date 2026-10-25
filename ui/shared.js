// Shared UI utilities and helpers
//
// This file is loaded after run-worker.js and before convert.js, eboot-ui.js
// and diagnose.js. It
// provides common functions used across all tabs: file size formatting, download
// triggers, format detection, disc ID auto-detection, CUE parsing, artwork
// management, tab switching, and a minimal ZIP creator for EBOOT downloads.
//
// All functions are globals (no module system — UI scripts are concatenated
// by build.js into a single <script> block).

// ── Constants ────────────────────────────────────────────────────────────────
const ISO_BLOCK_SIZE = 0x9300; // 37,632 bytes per PSISOIMG block

// ── Utilities ────────────────────────────────────────────────────────────────

/** Format a byte count as a human-readable string (e.g. 1.23 GB). */
function formatSize(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}

/** Trigger a browser download of a Uint8Array as a named file. */
function download(data, filename) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── Minimal ZIP creator (single stored file, no compression) ────────────────
// Used to wrap EBOOT.PBP in a ZIP for download, preserving the filename.
// Implements the bare minimum of PKZIP's APPNOTE spec: one local file header,
// one central directory entry, and an end-of-central-directory record.

/** CRC-32 (ISO 3309) with lazy table initialization. */
function crc32(data) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Create a ZIP archive containing one or more stored (uncompressed) files.
 *  @param {Array<{name: string, data: Uint8Array}>} entries */
function createZip(entries) {
  const enc = new TextEncoder();

  // Pre-compute per-entry metadata
  const meta = entries.map(e => {
    const nameBytes = enc.encode(e.name);
    return { nameBytes, crc: crc32(e.data), size: e.data.length, nameLen: nameBytes.length };
  });

  // Total size: local headers + data + central directory + EOCD
  const localSize = meta.reduce((sum, m) => sum + 30 + m.nameLen + m.size, 0);
  const cdSize = meta.reduce((sum, m) => sum + 46 + m.nameLen, 0);
  const totalSize = localSize + cdSize + 22;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;

  // Track local header offsets for the central directory
  const localOffsets = [];

  // Local file headers + data
  for (let i = 0; i < entries.length; i++) {
    const m = meta[i];
    localOffsets.push(off);
    view.setUint32(off, 0x04034B50, true); off += 4;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, m.crc, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint16(off, m.nameLen, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    bytes.set(m.nameBytes, off); off += m.nameLen;
    bytes.set(entries[i].data, off); off += m.size;
  }

  // Central directory
  const cdOffset = off;
  for (let i = 0; i < entries.length; i++) {
    const m = meta[i];
    view.setUint32(off, 0x02014B50, true); off += 4;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, m.crc, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint16(off, m.nameLen, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, 0, true); off += 4;
    view.setUint32(off, localOffsets[i], true); off += 4;
    bytes.set(m.nameBytes, off); off += m.nameLen;
  }

  // End of central directory
  const cdLen = off - cdOffset;
  view.setUint32(off, 0x06054B50, true); off += 4;
  view.setUint16(off, 0, true); off += 2;
  view.setUint16(off, 0, true); off += 2;
  view.setUint16(off, entries.length, true); off += 2;
  view.setUint16(off, entries.length, true); off += 2;
  view.setUint32(off, cdLen, true); off += 4;
  view.setUint32(off, cdOffset, true); off += 4;
  view.setUint16(off, 0, true); off += 2;

  return new Uint8Array(buf);
}

/** Create a ZIP archive in a Web Worker (off the main thread).
 *  @param {Array<{name: string, data: Uint8Array}>} entries
 *  @param {function(string, number, number): void} [onProgress] - called with (phase, index, total)
 *  @returns {Promise<Uint8Array>} */
async function createZipInWorker(entries, onProgress) {
  const message = { entries: entries.map(e => ({ name: e.name, data: e.data.buffer })) };
  const done = await runWorker(new Worker('zip-worker.js'), message, {
    transfer: entries.map(e => e.data.buffer),
    onProgress: (msg) => onProgress?.(msg.phase, msg.index, msg.total),
  });
  return new Uint8Array(done.result);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tabId) {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('active', panel.id === 'panel-' + tabId);
  }
}

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

// ── Artwork state ────────────────────────────────────────────────────────────
// Tracks the current artwork PNGs and whether each was user-provided (custom)
// or auto-generated. Custom artwork is preserved when the title/discId changes;
// auto-generated artwork gets regenerated.
let currentIcon0 = null;
let currentPic0 = null;
let currentPic1 = null;
let icon0IsCustom = false;
let pic0IsCustom = false;
let pic1IsCustom = false;

function canvasToUint8Array(canvas) {
  return new Promise(resolve => {
    canvas.toBlob(blob => {
      blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
    }, 'image/png');
  });
}


/**
 * Regenerate default artwork for any slot not overridden by the user.
 * Optionally fetches artwork from the psx-artwork repo by disc ID.
 */
async function regenerateDefaults() {
  const title = ebootTitle.value.trim();
  const discId = ebootDiscId.value.trim();
  const fetchCb = document.getElementById('ebootFetchArt');
  const shouldFetch = fetchCb && fetchCb.checked && discId;

  // Fetch all three types in parallel (each may independently 404)
  const fetched = shouldFetch
    ? await fetchAllArtwork(discId)
    : { icon0: null, pic0: null, pic1: null };

  if (!icon0IsCustom) {
    if (fetched.icon0) {
      currentIcon0 = await resizeImageToUint8Array(
        new Blob([fetched.icon0], { type: 'image/jpeg' }), 144, 80);
    } else {
      currentIcon0 = await generateDefaultIcon0(title);
    }
    artIcon0.src = URL.createObjectURL(new Blob([currentIcon0], { type: 'image/png' }));
  }
  if (!pic0IsCustom) {
    if (fetched.pic0) {
      currentPic0 = await resizeImageToUint8Array(
        new Blob([fetched.pic0], { type: 'image/jpeg' }), 310, 180);
    } else {
      currentPic0 = await generateDefaultPic0(title, discId);
    }
    artPic0.src = URL.createObjectURL(new Blob([currentPic0], { type: 'image/png' }));
  }
  if (!pic1IsCustom) {
    if (fetched.pic1) {
      currentPic1 = await resizeImageToUint8Array(
        new Blob([fetched.pic1], { type: 'image/jpeg' }), 480, 272);
    } else {
      currentPic1 = await generateDefaultPic1(title);
    }
    artPic1.src = URL.createObjectURL(new Blob([currentPic1], { type: 'image/png' }));
  }
}

/** Load an image file, resize it to targetW×targetH, and return as PNG Uint8Array. */
function resizeImageToUint8Array(file, targetW, targetH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = targetW;
      c.height = targetH;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, targetW, targetH);
      c.toBlob(blob => {
        blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
      }, 'image/png');
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Failed to load image')); };
    img.src = URL.createObjectURL(file);
  });
}

// ── Format detection ─────────────────────────────────────────────────────────

/** Detect disc image format by reading the 4-byte magic: CISO, ZISO, or ISO. */
async function detectConvertFormat(file) {
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const magic = String.fromCharCode(header[0], header[1], header[2], header[3]);
  if (magic === 'CISO') return 'CSO';
  if (magic === 'ZISO') return 'ZSO';
  return 'ISO';
}

function parseCsoHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    uncompressedSize: Number(dv.getBigUint64(8, true)),
    blockSize: dv.getUint32(16, true),
  };
}

// ── Auto-detect PS1 disc ID ──────────────────────────────────────────────────
// Duplicates some logic from eboot/discid.js for use in the UI thread (the
// eboot/ modules run in workers and aren't available here).

/** Extract a clean game title from a filename by stripping extensions and tags. */
function titleFromFilename(name) {
  return name
    .replace(/\.(bin|img|iso|cue)$/i, '')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ')  // remove (Disc 1), [NTSC-U], etc.
    .replace(/\s*-?\s*disc\s*\d+/i, '')
    .trim();
}

/**
 * Auto-detect disc ID and title from a PS1 BIN/ISO by reading SYSTEM.CNF.
 * Best-effort — returns null on failure without throwing.
 */
async function autoDetectDiscId(file) {
  try {
    const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const isRaw = header[0] === 0x00 && header[1] === 0xFF && header[2] === 0xFF
               && header[3] === 0xFF && header[11] === 0x00;
    const sectorSize = isRaw ? 2352 : 2048;
    const dataOffset = isRaw ? 24 : 0;

    const pvdStart = 16 * sectorSize + dataOffset;
    const pvdBuf = new Uint8Array(await file.slice(pvdStart, pvdStart + 2048).arrayBuffer());
    if (pvdBuf[0] !== 1 || String.fromCharCode(...pvdBuf.slice(1, 6)) !== 'CD001') return null;

    const rawVolumeId = String.fromCharCode(...pvdBuf.slice(40, 72)).trim();
    let title;
    if (rawVolumeId) {
      title = rawVolumeId.replace(/_/g, ' ').replace(/[A-Z]+/g, w => w[0] + w.slice(1).toLowerCase());
      console.log('[detect] Volume ID: "' + rawVolumeId + '" → title: "' + title + '"');
    } else {
      title = titleFromFilename(file.name);
      console.warn('[detect] Empty volume ID in ' + file.name + ', using filename → "' + title + '"');
    }

    const rootLba = pvdBuf[156+2]|(pvdBuf[156+3]<<8)|(pvdBuf[156+4]<<16)|(pvdBuf[156+5]<<24);
    const rootBuf = new Uint8Array(await file.slice(rootLba*sectorSize+dataOffset, rootLba*sectorSize+dataOffset+4096).arrayBuffer());

    let pos = 0;
    while (pos < rootBuf.length) {
      const recLen = rootBuf[pos];
      if (recLen === 0) break;
      const nameLen = rootBuf[pos + 32];
      const name = String.fromCharCode(...rootBuf.slice(pos+33, pos+33+nameLen)).split(';')[0].toUpperCase();
      if (name === 'SYSTEM.CNF') {
        const cnfLba = rootBuf[pos+2]|(rootBuf[pos+3]<<8)|(rootBuf[pos+4]<<16)|(rootBuf[pos+5]<<24);
        const cnfSize = rootBuf[pos+10]|(rootBuf[pos+11]<<8)|(rootBuf[pos+12]<<16)|(rootBuf[pos+13]<<24);
        const cnfBuf = new Uint8Array(await file.slice(cnfLba*sectorSize+dataOffset, cnfLba*sectorSize+dataOffset+Math.min(cnfSize,2048)).arrayBuffer());
        const cnfText = new TextDecoder('ascii').decode(cnfBuf);
        const m = cnfText.match(/BOOT\s*=\s*cdrom[:\d]*\\?\\?([A-Z]{4}_\d{3}\.\d{2})/i);
        if (m) return { discId: m[1].replace(/[_.]/g, ''), title };
      }
      // A PSP UMD has no SYSTEM.CNF: UMD_DATA.BIN starts "ULUS-10277|<hex>|0001|G".
      if (name === 'UMD_DATA.BIN') {
        const umdLba = rootBuf[pos+2]|(rootBuf[pos+3]<<8)|(rootBuf[pos+4]<<16)|(rootBuf[pos+5]<<24);
        const umdBuf = new Uint8Array(await file.slice(umdLba*sectorSize+dataOffset, umdLba*sectorSize+dataOffset+32).arrayBuffer());
        const m = new TextDecoder('ascii').decode(umdBuf).match(/^([A-Z]{4})-(\d{5})\|/);
        if (m) return { discId: m[1] + m[2], title };
      }
      pos += recLen;
    }
    if (title) return { discId: null, title };
  } catch (e) { /* best-effort */ }
  return null;
}

// ── CUE helpers ──────────────────────────────────────────────────────────────
// Light CUE parsing for the UI layer — extracts FILE references and track info
// to pair CUE sheets with their BIN files and build disc metadata.

/** Extract BIN filenames referenced by FILE directives in a CUE sheet. */
function extractBinNames(cueText) {
  const names = [];
  for (const line of cueText.split('\n')) {
    const m = line.trim().match(/^FILE\s+"([^"]+)"/i) || line.trim().match(/^FILE\s+(\S+)/i);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Match BIN filenames from a CUE to available File objects; merge multi-BIN into one. */
function mergeCueBins(binNames, availableBins) {
  if (binNames.length === 0) return null;
  const matched = [];
  const parts = [];
  for (const name of binNames) {
    const found = findBinFile(name, availableBins);
    if (!found && matched.length === 0) return null;
    if (found) {
      matched.push(found);
      parts.push(found);
    }
  }
  if (matched.length === 0) return null;
  if (matched.length === 1) return { merged: matched[0], matched, fileSizes: [matched[0].size] };
  const merged = new File(parts, matched[0].name, { type: matched[0].type });
  return { merged, matched, fileSizes: matched.map(f => f.size) };
}

/** Parse CUE track data for UI display and TOC generation (mirrors eboot/cue.js). */
function parseCueTracksUI(cueText) {
  const tracks = [];
  let current = null;
  let currentFile = null;
  for (const rawLine of cueText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const fm = line.match(/^FILE\s+"([^"]+)"/i) || line.match(/^FILE\s+(\S+)/i);
    if (fm) { currentFile = fm[1]; continue; }
    const tm = line.match(/^TRACK\s+(\d+)\s+(\S+)/i);
    if (tm) {
      const type = tm[2].toUpperCase();
      let ss = 2352;
      if (type === 'MODE1/2048') ss = 2048;
      else if (type === 'MODE2/2336') ss = 2336;
      current = { number: parseInt(tm[1],10), type, sectorSize: ss, pregap: 0, file: currentFile, indexes: [] };
      tracks.push(current);
      continue;
    }
    if (!current) continue;
    const im = line.match(/^INDEX\s+(\d+)\s+(\d+):(\d+):(\d+)/i);
    if (im) {
      current.indexes.push({ id: parseInt(im[1],10), msf: [parseInt(im[2],10), parseInt(im[3],10), parseInt(im[4],10)] });
      continue;
    }
    const pm = line.match(/^PREGAP\s+(\d+):(\d+):(\d+)/i);
    if (pm) {
      current.pregap = parseInt(pm[1],10)*60*75 + parseInt(pm[2],10)*75 + parseInt(pm[3],10);
    }
  }
  return tracks;
}
