// ══════════════════════════════════════════════════════════════════════════════
// DIAGNOSE TAB — General-purpose file inspector
//
// Drop any file to inspect its structure. Supports:
// - EBOOT.PBP: PBP header, SFO, PSAR layout, index table, sanity checks
// - CSO/ZSO: Header, block count, compression ratio, sample decompress
// - BIN/ISO: Sector size, disc ID, volume ID, title
// - CUE: Track listing, FILE references
// - Patches (IPS/PPF/BPS/VCDIFF): Format info, structural details
// - Unknown: Hex dump of first 64 bytes
// ══════════════════════════════════════════════════════════════════════════════

const diagnoseDropZone = document.getElementById('diagnoseDropZone');
const diagnoseFileInput = document.getElementById('diagnoseFileInput');
const diagnoseFileInfo = document.getElementById('diagnoseFileInfo');
const diagnoseFileName = document.getElementById('diagnoseFileName');
const diagnoseFileMeta = document.getElementById('diagnoseFileMeta');
const diagnoseProgressArea = document.getElementById('diagnoseProgressArea');
const diagnoseProgressFill = document.getElementById('diagnoseProgressFill');
const diagnoseProgressLabel = document.getElementById('diagnoseProgressLabel');
const diagnoseProgressPct = document.getElementById('diagnoseProgressPct');
const diagnoseStatus = document.getElementById('diagnoseStatus');
const diagnoseResults = document.getElementById('diagnoseResults');

let diagnoseWorking = false;

diagnoseDropZone.addEventListener('click', () => diagnoseFileInput.click());
diagnoseDropZone.addEventListener('dragover', e => { e.preventDefault(); diagnoseDropZone.classList.add('dragover'); });
diagnoseDropZone.addEventListener('dragleave', () => diagnoseDropZone.classList.remove('dragover'));
diagnoseDropZone.addEventListener('drop', e => {
  e.preventDefault();
  diagnoseDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleDiagnoseDrop(e.dataTransfer.files);
});
diagnoseFileInput.addEventListener('change', () => {
  if (diagnoseFileInput.files.length) handleDiagnoseDrop(diagnoseFileInput.files);
  diagnoseFileInput.value = '';
});

async function detectDiagnoseFormat(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'cue') return 'cue';

  if (file.size < 5) return 'unknown';
  const header = await readBytes(file, 0, 16);
  const magic4 = String.fromCharCode(header[0], header[1], header[2], header[3]);

  // PBP
  if (magic4 === '\0PBP') return 'pbp';
  // CSO
  if (magic4 === 'CISO') return 'cso';
  // ZSO
  if (magic4 === 'ZISO') return 'zso';
  // Patch formats
  if (header[0] === 0xD6 && header[1] === 0xC3 && header[2] === 0xC4) return 'xdelta';
  if (magic4 === 'BPS1') return 'bps';
  const magic5 = magic4 + String.fromCharCode(header[4]);
  if (magic5 === 'PATCH') return 'ips';
  if (header[0] === 0x50 && header[1] === 0x50 && header[2] === 0x46) return 'ppf';

  // PS1 save formats (identified by exact size, since none of the three has
  // a magic byte at offset 0 that's safe to check before size)
  if (file.size === DIAG_SAVE_MCR_SIZE) return 'save-mcr';
  if (file.size === DIAG_SAVE_VMP_SIZE && header[1] === 0x50 && header[2] === 0x4d && header[3] === 0x56) return 'save-vmp';
  if (file.size === DIAG_SAVE_GME_HEADER_SIZE + DIAG_SAVE_MCR_SIZE) {
    const gmeMagic = String.fromCharCode(...header.slice(0, DIAG_SAVE_GME_MAGIC.length));
    if (gmeMagic === DIAG_SAVE_GME_MAGIC) return 'save-gme';
  }

  // Raw disc: sync pattern 00 FF FF FF ... FF 00
  if (header[0] === 0x00 && header[1] === 0xFF && header[2] === 0xFF && header[11] === 0x00) return 'disc';

  // ISO 9660: check PVD at sector 16
  if (file.size > 16 * 2048 + 6) {
    const pvd = await readBytes(file, 16 * 2048, 6);
    if (pvd[0] === 1 && String.fromCharCode(pvd[1], pvd[2], pvd[3], pvd[4], pvd[5]) === 'CD001') return 'disc';
  }

  return 'unknown';
}

const FORMAT_LABELS = {
  pbp:     { cls: 'format-pbp', text: 'PBP' },
  cso:     { cls: 'format-cso-inspect', text: 'CSO' },
  zso:     { cls: 'format-zso-inspect', text: 'ZSO' },
  disc:    { cls: 'format-disc', text: 'DISC' },
  cue:     { cls: 'format-cue', text: 'CUE' },
  ips:     { cls: 'format-patch', text: 'IPS' },
  ppf:     { cls: 'format-patch', text: 'PPF' },
  bps:     { cls: 'format-patch', text: 'BPS' },
  xdelta:  { cls: 'format-patch', text: 'VCDIFF' },
  'save-gme': { cls: 'format-gme', text: 'GME' },
  'save-mcr': { cls: 'format-mcr', text: 'MCR' },
  'save-vmp': { cls: 'format-vmp', text: 'VMP' },
  unknown: { cls: 'format-unknown', text: '???' },
};

async function handleDiagnoseDrop(fileList) {
  if (diagnoseWorking) return;
  const file = fileList[0];

  diagnoseResults.innerHTML = '';
  diagnoseStatus.textContent = '';
  diagnoseStatus.className = 'status';
  diagnoseProgressArea.style.display = 'none';

  diagnoseFileName.textContent = file.name;
  diagnoseFileMeta.innerHTML = formatSize(file.size);
  diagnoseFileInfo.style.display = 'block';

  diagnoseWorking = true;
  diagnoseProgressArea.style.display = 'block';
  showDiagnoseProgress(0, 'Detecting format...');

  try {
    const fmt = await detectDiagnoseFormat(file);
    const label = FORMAT_LABELS[fmt] || FORMAT_LABELS.unknown;
    diagnoseFileMeta.innerHTML = `${formatSize(file.size)} <span class="format-label ${label.cls}">${label.text}</span>`;

    let html = '';
    switch (fmt) {
      case 'pbp': {
        const result = await inspectEboot(file);
        html = renderEbootSummary(result) + renderEbootResults(result);
        break;
      }
      case 'cso':
      case 'zso': {
        const result = await inspectCsoFile(file, fmt);
        html = renderCsoResults(result);
        break;
      }
      case 'disc': {
        const result = await inspectDiscFile(file);
        html = renderDiscResults(result);
        break;
      }
      case 'save-gme':
      case 'save-mcr':
      case 'save-vmp': {
        const result = await inspectSaveFile(file, fmt.slice(5));
        html = renderSaveResults(result);
        break;
      }
      case 'cue': {
        const result = await inspectCueFile(file);
        html = renderCueResults(result);
        break;
      }
      case 'ips':
      case 'ppf':
      case 'bps':
      case 'xdelta': {
        const result = await inspectPatchFile(file, fmt);
        html = renderPatchResults(result);
        break;
      }
      default: {
        const result = await inspectUnknownFile(file);
        html = renderUnknownResults(result);
      }
    }

    diagnoseResults.innerHTML = html;
    initCollapsibles();
    initDiagnoseTabs();
    diagnoseStatus.textContent = 'Inspection complete';
  } catch (e) {
    diagnoseStatus.textContent = 'Error: ' + e.message;
    diagnoseStatus.className = 'status error';
  } finally {
    diagnoseWorking = false;
    diagnoseProgressArea.style.display = 'none';
  }
}

function showDiagnoseProgress(pct, label) {
  const p = Math.round(pct * 100);
  diagnoseProgressFill.style.width = p + '%';
  diagnoseProgressPct.textContent = p + '%';
  diagnoseProgressLabel.textContent = label;
}

// ── Inspector engine (ported from tools/inspect-eboot.js) ────────────────────

const PBP_HEADER_SIZE = 0x28;
const PBP_SECTION_NAMES = [
  'PARAM.SFO', 'ICON0.PNG', 'ICON1.PMF', 'PIC0.PNG',
  'PIC1.PNG', 'SND0.AT3', 'DATA.PSP', 'DATA.PSAR',
];
const SFO_MAGIC = 0x46535000;
const SFO_UTF8S = 0x0004;
const SFO_UTF8 = 0x0204;
const SFO_INT32 = 0x0404;
// ISO_BLOCK_SIZE declared in shared.js
const INDEX_ENTRY_SIZE = 32;
const ISO_DATA_BASE = 0x100000;
const STARTDAT_CONST = 0x2D31;

async function readBytes(file, offset, length) {
  const buf = await file.slice(offset, offset + length).arrayBuffer();
  return new Uint8Array(buf);
}

async function readU32(file, offset) {
  const b = await readBytes(file, offset, 4);
  return b[0] | (b[1] << 8) | (b[2] << 16) | ((b[3] << 24) >>> 0);
}

function hex(n) {
  return '0x' + n.toString(16).toUpperCase();
}

function fromBcd(b) {
  return ((b >> 4) & 0xF) * 10 + (b & 0xF);
}

async function readNullString(file, offset, maxLen) {
  const buf = await readBytes(file, offset, maxLen);
  let end = 0;
  while (end < maxLen && buf[end] !== 0) end++;
  return new TextDecoder('utf-8').decode(buf.slice(0, end));
}

async function inspectPbpHeader(file) {
  const header = await readBytes(file, 0, PBP_HEADER_SIZE);
  const dv = new DataView(header.buffer);
  const magic = new TextDecoder('ascii').decode(header.slice(0, 4));
  const version = dv.getUint32(4, true);

  const offsets = [];
  for (let i = 0; i < 8; i++) {
    offsets.push(dv.getUint32(8 + i * 4, true));
  }

  const sections = offsets.map((offset, i) => {
    const end = i < 7 ? offsets[i + 1] : file.size;
    return {
      name: PBP_SECTION_NAMES[i],
      offset,
      size: end - offset,
      empty: end - offset === 0,
    };
  });

  return {
    magic,
    version: `${(version >> 16) & 0xFF}.${version & 0xFFFF}`,
    versionRaw: version,
    offsets,
    sections,
  };
}

async function inspectSfo(file, offset, size) {
  if (size < 20) return { error: 'SFO too small' };

  const sfo = await readBytes(file, offset, size);
  const dv = new DataView(sfo.buffer);
  const magic = dv.getUint32(0, true);
  if (magic !== SFO_MAGIC) return { error: `Bad SFO magic: ${hex(magic)}` };

  const version = dv.getUint32(4, true);
  const keyTableOff = dv.getUint32(8, true);
  const dataTableOff = dv.getUint32(12, true);
  const entryCount = dv.getUint32(16, true);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const base = 20 + i * 16;
    const keyOff = dv.getUint16(base, true);
    const dataType = dv.getUint16(base + 2, true);
    const dataUsed = dv.getUint32(base + 4, true);
    const dataMax = dv.getUint32(base + 8, true);
    const dataOff = dv.getUint32(base + 12, true);

    let keyEnd = keyTableOff + keyOff;
    while (keyEnd < size && sfo[keyEnd] !== 0) keyEnd++;
    const key = new TextDecoder('utf-8').decode(sfo.slice(keyTableOff + keyOff, keyEnd));

    let value;
    const valStart = dataTableOff + dataOff;
    if (dataType === SFO_INT32) {
      value = dv.getUint32(valStart, true);
    } else {
      let valEnd = valStart + dataUsed;
      while (valEnd > valStart && sfo[valEnd - 1] === 0) valEnd--;
      value = new TextDecoder('utf-8').decode(sfo.slice(valStart, valEnd));
    }

    entries.push({
      key,
      type: dataType === SFO_INT32 ? 'int32' : dataType === SFO_UTF8S ? 'utf8s' : 'utf8',
      value,
      usedSize: dataUsed,
      maxSize: dataMax,
    });
  }

  return {
    magic: hex(magic),
    version: `${(version >> 8) & 0xFF}.${version & 0xFF}`,
    keyTableOffset: keyTableOff,
    dataTableOffset: dataTableOff,
    entryCount,
    entries,
  };
}

async function isTocAt(file, absOffset) {
  const first = await readBytes(file, absOffset, 3);
  return (first[0] === 0x41 || first[0] === 0x01) && first[1] === 0x00 && first[2] === 0xA0;
}

async function inspectToc(file, absOffset) {
  const maxTocBytes = 102 * 10;
  const tocBuf = await readBytes(file, absOffset, maxTocBytes);
  const entries = [];

  for (let i = 0; i < 102; i++) {
    const base = i * 10;
    const addrCtrl = tocBuf[base];
    const tno = tocBuf[base + 1];
    const point = tocBuf[base + 2];

    if (addrCtrl === 0 && tno === 0 && point === 0) break;

    const pmin = fromBcd(tocBuf[base + 7]);
    const psec = fromBcd(tocBuf[base + 8]);
    const pframe = fromBcd(tocBuf[base + 9]);

    let pointLabel;
    if (point === 0xA0) pointLabel = 'A0 (first track)';
    else if (point === 0xA1) pointLabel = 'A1 (last track)';
    else if (point === 0xA2) pointLabel = 'A2 (lead-out)';
    else pointLabel = `Track ${fromBcd(point)}`;

    const isData = (addrCtrl & 0x40) !== 0;
    entries.push({
      point: hex(point),
      pointLabel,
      type: isData ? 'data' : 'audio',
      pmsf: `${String(pmin).padStart(2, '0')}:${String(psec).padStart(2, '0')}:${String(pframe).padStart(2, '0')}`,
    });
  }

  return { entryCount: entries.length, entries };
}

async function probeIndexAt(file, absOffset, fileSize) {
  if (absOffset + INDEX_ENTRY_SIZE > fileSize) return false;
  const first = await readBytes(file, absOffset, 8);
  const dv = new DataView(first.buffer);
  const offset = dv.getUint32(0, true);
  const length = dv.getUint32(4, true);
  return offset === 0 && length > 0 && length <= ISO_BLOCK_SIZE;
}

async function inspectIndexTable(file, absOffset, fileSize) {
  const maxEntries = Math.min(500000, Math.floor((fileSize - absOffset) / INDEX_ENTRY_SIZE));
  let numEntries = 0;
  let minLen = Infinity, maxLen = 0;
  let firstOffset = 0, firstLength = 0;
  let lastOffset = 0, lastLength = 0;
  let prevEnd = 0, gaps = 0, overlaps = 0, hashedEntries = 0;

  const chunkSize = 1024;
  for (let chunk = 0; chunk < maxEntries; chunk += chunkSize) {
    const count = Math.min(chunkSize, maxEntries - chunk);
    const buf = await readBytes(file, absOffset + chunk * INDEX_ENTRY_SIZE, count * INDEX_ENTRY_SIZE);
    const dv = new DataView(buf.buffer);

    for (let i = 0; i < count; i++) {
      const base = i * INDEX_ENTRY_SIZE;
      const offset = dv.getUint32(base, true);
      const length = dv.getUint32(base + 4, true);

      if (length === 0 || length > ISO_BLOCK_SIZE) return buildResult();

      if (numEntries === 0) {
        firstOffset = offset;
        firstLength = length;
      } else {
        if (offset < prevEnd) overlaps++;
        else if (offset > prevEnd) gaps++;
      }
      // Check for non-zero SHA-1 hash at bytes 8-28
      let hasHash = false;
      for (let h = base + 8; h < base + 28; h++) {
        if (buf[h] !== 0) { hasHash = true; break; }
      }
      if (hasHash) hashedEntries++;
      prevEnd = offset + length;
      lastOffset = offset;
      lastLength = length;
      if (length < minLen) minLen = length;
      if (length > maxLen) maxLen = length;
      numEntries++;
    }
  }

  function buildResult() {
    const compressedTotal = numEntries > 0 ? lastOffset + lastLength : 0;
    return {
      entryCount: numEntries,
      firstEntry: { offset: firstOffset, length: firstLength },
      lastEntry: { offset: lastOffset, length: lastLength },
      minBlockSize: minLen === Infinity ? 0 : minLen,
      maxBlockSize: maxLen,
      gaps,
      overlaps,
      hashedEntries,
      compressedTotal,
      uncompressedTotal: numEntries * ISO_BLOCK_SIZE,
      ratio: numEntries > 0 ? (compressedTotal / (numEntries * ISO_BLOCK_SIZE) * 100).toFixed(1) + '%' : 'N/A',
    };
  }

  return buildResult();
}

async function sampleDecompress(file, psisoAbsOffset, indexAbsOffset, indexInfo) {
  if (indexInfo.entryCount === 0) return [];
  if (typeof inflateRaw === 'undefined') return [{ block: 0, error: 'inflateRaw not available' }];

  const results = [];
  const indices = [0, indexInfo.entryCount - 1];

  for (const idx of indices) {
    const entryBuf = await readBytes(file, indexAbsOffset + idx * INDEX_ENTRY_SIZE, 8);
    const dv = new DataView(entryBuf.buffer);
    const offset = dv.getUint32(0, true);
    const length = dv.getUint32(4, true);
    const absDataOffset = psisoAbsOffset + ISO_DATA_BASE + offset;

    const sample = { block: idx, compressedSize: length };

    if (length === ISO_BLOCK_SIZE) {
      sample.stored = 'uncompressed';
      sample.decompressedSize = ISO_BLOCK_SIZE;
    } else {
      try {
        const blockData = await readBytes(file, absDataOffset, length);
        const inflated = inflateRaw(blockData);
        sample.stored = 'compressed';
        sample.decompressedSize = inflated.length;
        sample.ok = inflated.length === ISO_BLOCK_SIZE;
      } catch (e) {
        sample.stored = 'compressed';
        sample.error = e.message;
      }
    }
    results.push(sample);
  }

  return results;
}

async function analyzeBtypes(file, psisoAbsOffset, indexAbsOffset, indexInfo) {
  if (indexInfo.entryCount === 0) return { fixed: 0, dynamic: 0, stored: 0, raw: 0 };
  let fixed = 0, dynamic = 0, stored = 0, raw = 0;
  for (let i = 0; i < indexInfo.entryCount; i++) {
    const entryBuf = await readBytes(file, indexAbsOffset + i * INDEX_ENTRY_SIZE, 8);
    const dv = new DataView(entryBuf.buffer);
    const length = dv.getUint32(4, true);
    if (length === ISO_BLOCK_SIZE) { raw++; continue; }
    const absDataOffset = psisoAbsOffset + ISO_DATA_BASE + dv.getUint32(0, true);
    const firstByte = (await readBytes(file, absDataOffset, 1))[0];
    const btype = (firstByte >> 1) & 3;
    if (btype === 0) stored++;
    else if (btype === 1) fixed++;
    else if (btype === 2) dynamic++;
  }
  return { fixed, dynamic, stored, raw };
}

async function detectVariant(file, absOffset) {
  const probe = await readBytes(file, absOffset + 0x400, 4);
  if (probe[0] === 0x5F) return 'sony';
  if (await isTocAt(file, absOffset + 0x400)) return 'popstationr';
  if (await probeIndexAt(file, absOffset + 0x4000, file.size)) return 'sony';
  if (await probeIndexAt(file, absOffset + 0x3C00, file.size)) return 'popstationr';
  return 'unknown';
}

async function inspectPsisoimg(file, absOffset, label) {
  const magicBuf = await readBytes(file, absOffset, 12);
  const magic = new TextDecoder('ascii').decode(magicBuf);
  if (magic !== 'PSISOIMG0000') {
    return { error: `Bad PSISOIMG magic: "${magic}"`, label };
  }

  const p1_offset = await readU32(file, absOffset + 0x0C);
  const variant = await detectVariant(file, absOffset);

  const tocOffset = variant === 'sony' ? 0x800 : 0x400;
  const indexOffset = variant === 'sony' ? 0x4000 : 0x3C00;

  const reserved = await readBytes(file, absOffset + 0x10, 0x3F0);
  let nonZeroCount = 0;
  for (let i = 0; i < reserved.length; i++) {
    if (reserved[i] !== 0) nonZeroCount++;
  }

  let discIdAt400 = null;
  if (variant === 'sony') {
    discIdAt400 = await readNullString(file, absOffset + 0x400, 16);
  }

  let toc = { entryCount: 0, entries: [] };
  if (await isTocAt(file, absOffset + tocOffset)) {
    toc = await inspectToc(file, absOffset + tocOffset);
  }

  const p2_offset = await readU32(file, absOffset + 0x0E20);

  let title = '';
  if (variant === 'popstationr') {
    title = await readNullString(file, absOffset + 0x0E24 + 8, 128);
  } else {
    for (const probe of [0x0E24 + 8, 0x1218, 0x1220, 0x1228, 0x1008]) {
      const s = await readNullString(file, absOffset + probe, 128);
      if (s.length >= 3 && /^[\x20-\x7E]+$/.test(s)) {
        title = s;
        break;
      }
    }
  }

  const indexAbsOffset = absOffset + indexOffset;
  const indexInfo = await inspectIndexTable(file, indexAbsOffset, file.size);

  let startdatMagic = null;
  let startdatRelOffset = null;
  if (indexInfo.compressedTotal > 0) {
    const sdAbsOffset = absOffset + ISO_DATA_BASE + indexInfo.compressedTotal;
    startdatRelOffset = ISO_DATA_BASE + indexInfo.compressedTotal;
    if (sdAbsOffset + 8 <= file.size) {
      const sdBuf = await readBytes(file, sdAbsOffset, 8);
      startdatMagic = new TextDecoder('ascii').decode(sdBuf).replace(/\0/g, '');
    }
  }

  const btypes = await analyzeBtypes(file, absOffset, indexAbsOffset, indexInfo);
  const samples = await sampleDecompress(file, absOffset, indexAbsOffset, indexInfo);

  const compressedTotal = indexInfo.compressedTotal;
  const uncompressedTotal = indexInfo.entryCount * ISO_BLOCK_SIZE;
  const expectedP1_compressed = compressedTotal + ISO_DATA_BASE;
  const expectedP1_aligned = (expectedP1_compressed + 0xF) & ~0xF;
  const expectedP1_uncompressed = uncompressedTotal + ISO_DATA_BASE;
  const p1_ok = p1_offset === expectedP1_compressed || p1_offset === expectedP1_aligned || p1_offset === expectedP1_uncompressed;
  const checks = {
    p1_matches: p1_ok,
    p1_compressed: expectedP1_compressed,
    p1_uncompressed: expectedP1_uncompressed,
    p2_matches: p2_offset === 0,
    firstIndexOffsetZero: indexInfo.entryCount === 0 || indexInfo.firstEntry.offset === 0,
    allBlocksInRange: indexInfo.maxBlockSize <= ISO_BLOCK_SIZE,
  };

  return {
    label,
    variant,
    magic,
    p1_offset,
    p2_offset,
    tocOffset,
    indexOffset,
    discIdAt400,
    reservedAreaClean: nonZeroCount === 0,
    reservedNonZeroBytes: nonZeroCount,
    toc,
    title,
    indexTable: indexInfo,
    startdatOffset: startdatRelOffset,
    startdatMagic,
    btypes,
    samples,
    sanityChecks: checks,
  };
}

async function inspectPsar(file, psarOffset) {
  const magicBuf = await readBytes(file, psarOffset, 14);
  const magic = new TextDecoder('ascii').decode(magicBuf).replace(/\0/g, '');

  if (magic.startsWith('PSTITLEIMG')) {
    showDiagnoseProgress(0.3, 'Reading multi-disc structure...');
    const discOffsets = [];
    for (let i = 0; i < 5; i++) {
      const off = await readU32(file, psarOffset + 0x200 + i * 4);
      if (off === 0 && i > 0) break;
      discOffsets.push(off);
    }

    const discs = [];
    for (let i = 0; i < discOffsets.length; i++) {
      showDiagnoseProgress(0.3 + 0.6 * (i / discOffsets.length), `Inspecting disc ${i + 1}...`);
      discs.push(await inspectPsisoimg(file, psarOffset + discOffsets[i], `Disc ${i + 1}`));
    }

    return { type: 'PSTITLEIMG', discCount: discOffsets.length, discOffsets, discs };
  } else if (magic.startsWith('PSISOIMG')) {
    showDiagnoseProgress(0.3, 'Inspecting PSISOIMG...');
    const disc = await inspectPsisoimg(file, psarOffset, 'Single disc');
    return { type: 'PSISOIMG', discCount: 1, discs: [disc] };
  } else {
    return { type: 'unknown', magic };
  }
}

async function sha1Hex(data) {
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function inspectEboot(file) {
  showDiagnoseProgress(0.1, 'Reading PBP header...');
  const pbp = await inspectPbpHeader(file);

  showDiagnoseProgress(0.2, 'Reading PARAM.SFO...');
  const sfo = await inspectSfo(file, pbp.offsets[0], pbp.offsets[1] - pbp.offsets[0]);

  // DATA.PSP SHA-1
  const dataPspOffset = pbp.offsets[6];
  const dataPspSize = pbp.offsets[7] - dataPspOffset;
  let dataPspSha1 = null;
  if (dataPspSize > 0) {
    const dataPsp = await readBytes(file, dataPspOffset, dataPspSize);
    dataPspSha1 = await sha1Hex(dataPsp);
  }

  const psar = await inspectPsar(file, pbp.offsets[7]);
  showDiagnoseProgress(1, 'Done');

  return { fileSize: file.size, pbp, sfo, dataPspSha1, psar };
}

// ── New inspectors ───────────────────────────────────────────────────────────

async function inspectCsoFile(file, fmt) {
  showDiagnoseProgress(0.2, 'Reading CSO header...');
  const headerBuf = await readBytes(file, 0, 24);
  const parsed = parseCsoHeader(headerBuf);
  const blockSize = parsed.blockSize;
  const uncompressedSize = parsed.uncompressedSize;
  const blockCount = Math.ceil(uncompressedSize / blockSize);

  // Read index to compute compression stats
  showDiagnoseProgress(0.4, 'Reading block index...');
  const indexSize = (blockCount + 1) * 4;
  const indexBuf = await readBytes(file, 24, Math.min(indexSize, file.size - 24));
  const idxDv = new DataView(indexBuf.buffer, indexBuf.byteOffset, indexBuf.byteLength);

  let compressedBlocks = 0, storedBlocks = 0;
  let totalCompressed = 0;
  for (let i = 0; i < blockCount && (i + 1) * 4 < indexBuf.length; i++) {
    const raw0 = idxDv.getUint32(i * 4, true);
    const raw1 = idxDv.getUint32((i + 1) * 4, true);
    const isUncompressed = (raw0 >>> 31) !== 0;
    const off0 = raw0 & 0x7FFFFFFF;
    const off1 = raw1 & 0x7FFFFFFF;
    const len = off1 - off0;
    totalCompressed += len;
    if (isUncompressed) storedBlocks++;
    else compressedBlocks++;
  }

  const ratio = uncompressedSize > 0 ? (file.size / uncompressedSize * 100).toFixed(1) : 'N/A';

  // Sample decompress first block
  let sampleResult = null;
  if (blockCount > 0 && typeof inflateRaw !== 'undefined' && fmt === 'cso') {
    showDiagnoseProgress(0.7, 'Sample decompressing...');
    const raw0 = idxDv.getUint32(0, true);
    const raw1 = idxDv.getUint32(4, true);
    const isUncompressed = (raw0 >>> 31) !== 0;
    const off0 = raw0 & 0x7FFFFFFF;
    const off1 = raw1 & 0x7FFFFFFF;
    const len = off1 - off0;
    try {
      const blockData = await readBytes(file, off0, len);
      if (isUncompressed) {
        sampleResult = { stored: 'uncompressed', size: len };
      } else {
        const inflated = inflateRaw(blockData);
        sampleResult = { stored: 'compressed', compressedSize: len, decompressedSize: inflated.length, ok: inflated.length === blockSize };
      }
    } catch (e) {
      sampleResult = { error: e.message };
    }
  }

  showDiagnoseProgress(1, 'Done');
  return {
    format: fmt.toUpperCase(),
    fileSize: file.size,
    uncompressedSize,
    blockSize,
    blockCount,
    compressedBlocks,
    storedBlocks,
    ratio,
    sampleResult,
  };
}

async function inspectDiscFile(file) {
  showDiagnoseProgress(0.2, 'Detecting disc format...');
  const header = await readBytes(file, 0, 16);
  const isRaw = header[0] === 0x00 && header[1] === 0xFF && header[2] === 0xFF
             && header[3] === 0xFF && header[11] === 0x00;
  const sectorSize = isRaw ? 2352 : 2048;
  const dataOffset = isRaw ? 24 : 0;
  const sectorCount = Math.floor(file.size / sectorSize);

  let volumeId = '', volumeSize = 0;
  let discId = null, title = null;

  // Read PVD
  showDiagnoseProgress(0.4, 'Reading ISO 9660 PVD...');
  const pvdStart = 16 * sectorSize + dataOffset;
  if (pvdStart + 2048 <= file.size) {
    const pvd = await readBytes(file, pvdStart, 2048);
    if (pvd[0] === 1 && String.fromCharCode(pvd[1], pvd[2], pvd[3], pvd[4], pvd[5]) === 'CD001') {
      volumeId = new TextDecoder('ascii').decode(pvd.slice(40, 72)).trim();
      const dvPvd = new DataView(pvd.buffer);
      volumeSize = dvPvd.getUint32(80, true); // volume space size in blocks
    }
  }

  // Auto-detect disc ID and title
  showDiagnoseProgress(0.6, 'Detecting disc ID...');
  const detected = await autoDetectDiscId(file);
  if (detected) {
    discId = detected.discId;
    title = detected.title;
  }
  if (!title && volumeId) {
    title = volumeId.replace(/_/g, ' ').replace(/[A-Z]+/g, w => w[0] + w.slice(1).toLowerCase());
  }
  if (!title) title = titleFromFilename(file.name);

  showDiagnoseProgress(1, 'Done');
  return {
    fileSize: file.size,
    sectorSize,
    isRaw,
    sectorCount,
    volumeId,
    volumeSize,
    discId,
    title,
  };
}

// ── PS1 save card (GME/MCR/VMP) inspector ────────────────────────────────────
//
// Duplicates save/gme.js's stripGmeHeader() and save/mcr.js's parseMcr()
// locally rather than importing them, same tradeoff as ui/save-manager.js
// and ui/shared.js's autoDetectDiscId (ui/*.js files are plain concatenated
// scripts, not ES modules). Unlike save-manager.js, this shows ALL 15 slots
// (not just active saves) since the point here is transparency into every
// state, including deleted/corrupted ones. Everything runs synchronously on
// the main thread except the VMP signature check, which is dispatched to
// save-worker.js because it needs AES-128-ECB (no native browser API --
// see save/aes-ecb.js) and duplicating that primitive here would mean two
// copies of the same crypto code to keep in sync.

const DIAG_SAVE_MCR_SIZE = 131072;
const DIAG_SAVE_HEADER_SIZE = 128;
const DIAG_SAVE_MAX_SLOTS = 15;
const DIAG_SAVE_GME_HEADER_SIZE = 3904;
const DIAG_SAVE_GME_MAGIC = '123-456-STD';
const DIAG_SAVE_VMP_SIZE = 0x20080;
const DIAG_SAVE_VMP_MCR_OFFSET = 0x80;

const DIAG_SAVE_BLOCK_TYPES = {
  0xa0: 'formatted',
  0x51: 'initial',
  0x52: 'middle-link',
  0x53: 'end-link',
  0xa1: 'deleted-initial',
  0xa2: 'deleted-middle-link',
  0xa3: 'deleted-end-link',
};

const SAVE_KIND_NAMES = { gme: 'GME (DexDrive)', mcr: 'Raw MCR', vmp: 'VMP (PSP/Vita POPS)' };

function saveAsciiSlice2(buf, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = buf[start + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** Unwrap a GME/MCR/VMP file down to its raw 128KB memory card. */
function saveToRawMcr(data, kind) {
  if (kind === 'mcr') return data;
  if (kind === 'gme') return data.subarray(DIAG_SAVE_GME_HEADER_SIZE);
  return data.subarray(DIAG_SAVE_VMP_MCR_OFFSET, DIAG_SAVE_VMP_MCR_OFFSET + DIAG_SAVE_MCR_SIZE); // 'vmp'
}

/** Parse all 15 directory slots, including raw state/link bytes for display. */
function parseSaveMcr(data) {
  const slots = [];
  for (let i = 0; i < DIAG_SAVE_MAX_SLOTS; i++) {
    const off = DIAG_SAVE_HEADER_SIZE * (i + 1);
    const header = data.subarray(off, off + DIAG_SAVE_HEADER_SIZE);
    slots.push({
      index: i,
      stateByte: header[0],
      type: DIAG_SAVE_BLOCK_TYPES[header[0]] || 'corrupted',
      size: header[4] | (header[5] << 8) | (header[6] << 16),
      nextByte: header[8],
      region: saveAsciiSlice2(header, 0x0a, 2),
      productCode: saveAsciiSlice2(header, 0x0c, 10),
      identifier: saveAsciiSlice2(header, 0x16, 8),
      name: saveAsciiSlice2(header, 0x0a, 20),
    });
  }
  return slots;
}

/** Ask save-worker.js to recompute a VMP's signature and report a match/mismatch. */
function verifyVmpSignature(vmpBytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('save-worker.js');

    worker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.result);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = function(err) {
      worker.terminate();
      reject(new Error(err.message || String(err)));
    };

    worker.postMessage({ action: 'verifyVmp', vmp: vmpBytes.buffer.slice(vmpBytes.byteOffset, vmpBytes.byteOffset + vmpBytes.byteLength) });
  });
}

async function inspectSaveFile(file, kind) {
  showDiagnoseProgress(0.2, 'Reading card...');
  const data = new Uint8Array(await file.arrayBuffer());
  const mcr = saveToRawMcr(data, kind);
  const slots = parseSaveMcr(mcr);
  const info = { kind, fileSize: file.size, slots };

  if (kind === 'vmp') {
    showDiagnoseProgress(0.6, 'Verifying signature...');
    info.signature = await verifyVmpSignature(data);
  }

  showDiagnoseProgress(1, 'Done');
  return info;
}

function saveTypeLabel(type) {
  if (type === 'corrupted') return `<span class="check-fail">${esc(type)}</span>`;
  if (type.startsWith('deleted')) return `<span class="check-warn">${esc(type)}</span>`;
  return esc(type);
}

function renderSaveResults(r) {
  const occupied = r.slots.filter(s => s.type === 'initial' || s.type === 'deleted-initial');
  const summaryParts = [SAVE_KIND_NAMES[r.kind], formatSize(r.fileSize), `${occupied.length} save${occupied.length !== 1 ? 's' : ''}`];
  if (r.signature) summaryParts.push(r.signature.valid ? 'signature valid' : 'signature MISMATCH');
  const summary = `<div class="diagnose-summary">${summaryParts.map(esc).join(' &mdash; ')}</div>`;

  let body = '';

  if (r.signature) {
    body += '<table>';
    body += `<tr><td>Signature</td><td>${badge(r.signature.valid, r.signature.valid ? 'matches recomputed hash' : `expected ${r.signature.expected}, got ${r.signature.stored}`)}</td></tr>`;
    body += '</table>';
  }

  body += '<table>';
  body += '<tr><td>Slot</td><td>State</td><td>Region/Code</td><td>Size</td><td>Link</td></tr>';
  for (const s of r.slots) {
    const stateLabel = `${saveTypeLabel(s.type)} <span class="hex">${hex(s.stateByte)}</span>`;
    const codeLabel = s.productCode ? esc(s.name) : '<span style="color:#666">&mdash;</span>';
    const sizeLabel = s.size > 0 ? formatSize(s.size) : '';
    const linkLabel = s.nextByte === 0xff ? '' : `&rarr; slot ${s.nextByte}`;
    body += `<tr><td>${s.index}</td><td>${stateLabel}</td><td>${codeLabel}</td><td>${sizeLabel}</td><td>${linkLabel}</td></tr>`;
  }
  body += '</table>';

  return summary + collapsibleSection('Memory Card Directory (all 15 slots)', body, true);
}

async function inspectCueFile(file) {
  showDiagnoseProgress(0.3, 'Parsing CUE sheet...');
  const text = await file.text();
  const binNames = extractBinNames(text);
  const tracks = parseCueTracksUI(text);
  showDiagnoseProgress(1, 'Done');
  return { fileSize: file.size, text, binNames, tracks };
}

// BPS varint decoder (matches patch/bps.js:decodeBPSInt)
function decodeBPSVarInt(data, offset) {
  let value = 0, shift = 1, pos = offset;
  while (pos < data.length) {
    const b = data[pos++];
    value += (b & 0x7F) * shift;
    if (b & 0x80) break;
    shift <<= 7;
    value += shift;
  }
  return { value, newOffset: pos };
}

// VCDIFF varint decoder (7-bit big-endian, high bit = continuation)
function decodeVCDIFFInt(data, offset) {
  let val = 0, pos = offset;
  while (pos < data.length) {
    const b = data[pos++];
    val = val * 128 + (b & 0x7F);
    if (!(b & 0x80)) break;
  }
  return { value: val, newOffset: pos };
}

async function inspectPatchFile(file, fmt) {
  showDiagnoseProgress(0.3, 'Reading patch...');
  const data = new Uint8Array(await file.arrayBuffer());
  const info = { format: fmt, fileSize: file.size };

  switch (fmt) {
    case 'ips': {
      let pos = 5; // skip "PATCH"
      let records = 0, rleRecords = 0, totalDataBytes = 0;
      let minOffset = Infinity, maxEnd = 0;
      let hasTruncation = false;
      while (pos + 3 <= data.length) {
        if (data[pos] === 0x45 && data[pos+1] === 0x4F && data[pos+2] === 0x46) {
          pos += 3;
          if (pos + 3 <= data.length) hasTruncation = true;
          break;
        }
        const offset = (data[pos] << 16) | (data[pos+1] << 8) | data[pos+2];
        pos += 3;
        const size = (data[pos] << 8) | data[pos+1];
        pos += 2;
        if (size === 0) {
          // RLE
          const count = (data[pos] << 8) | data[pos+1];
          pos += 3; // 2 count + 1 value
          rleRecords++;
          totalDataBytes += count;
          if (offset < minOffset) minOffset = offset;
          if (offset + count > maxEnd) maxEnd = offset + count;
        } else {
          pos += size;
          totalDataBytes += size;
          if (offset < minOffset) minOffset = offset;
          if (offset + size > maxEnd) maxEnd = offset + size;
        }
        records++;
      }
      info.records = records;
      info.rleRecords = rleRecords;
      info.totalDataBytes = totalDataBytes;
      info.patchedRange = records > 0 ? { start: minOffset, end: maxEnd } : null;
      info.hasTruncation = hasTruncation;
      break;
    }
    case 'ppf': {
      info.version = data[5] - 0x30;
      info.encoding = data[4] === 0 ? 'BIN' : 'GI';
      if (info.version >= 2 && data.length >= 56) {
        info.description = new TextDecoder('ascii').decode(data.slice(6, 56)).replace(/\0+$/, '');
      }

      // Count records and detect block check / undo
      let recordStart, recordEnd, offsetSize;
      if (info.version === 3) {
        info.imageType = data[56] === 1 ? 'GI' : 'BIN';
        info.hasBlockCheck = data[57] === 1;
        info.hasUndo = data[58] === 1;
        recordStart = info.hasBlockCheck ? 1084 : 60;
        recordEnd = data.length;
        offsetSize = 8;
      } else if (info.version === 2) {
        // v2: possible block check trailer (last 1028 bytes)
        info.hasBlockCheck = data.length > 56 + 1028;
        recordStart = 56;
        recordEnd = info.hasBlockCheck ? data.length - 1028 : data.length;
        offsetSize = 4;
        info.hasUndo = false;
      } else {
        recordStart = 56;
        recordEnd = data.length;
        offsetSize = 4;
        info.hasBlockCheck = false;
        info.hasUndo = false;
      }

      let records = 0, totalDataBytes = 0;
      let pos = recordStart;
      const undoMul = info.hasUndo ? 2 : 1;
      while (pos + offsetSize + 1 <= recordEnd) {
        pos += offsetSize; // skip offset
        const len = data[pos]; pos += 1;
        if (pos + len * undoMul > recordEnd) break;
        totalDataBytes += len;
        pos += len * undoMul;
        records++;
      }
      info.records = records;
      info.totalDataBytes = totalDataBytes;
      break;
    }
    case 'bps': {
      let pos = 4; // skip "BPS1"
      const src = decodeBPSVarInt(data, pos); pos = src.newOffset;
      const tgt = decodeBPSVarInt(data, pos); pos = tgt.newOffset;
      const meta = decodeBPSVarInt(data, pos); pos = meta.newOffset;
      info.sourceSize = src.value;
      info.targetSize = tgt.value;
      info.metadataSize = meta.value;
      if (meta.value > 0 && pos + meta.value <= data.length) {
        const raw = new TextDecoder('utf-8').decode(data.slice(pos, pos + meta.value));
        info.metadata = raw.replace(/\0+$/, '');
      }
      pos += meta.value;

      // Count commands by type
      const footerStart = data.length - 12;
      let sourceRead = 0, targetRead = 0, sourceCopy = 0, targetCopy = 0, commands = 0;
      while (pos < footerStart) {
        const cmd = decodeBPSVarInt(data, pos); pos = cmd.newOffset;
        const action = cmd.value & 0x03;
        const length = (cmd.value >> 2) + 1;
        if (action === 0) sourceRead++;
        else if (action === 1) { targetRead++; pos += length; }
        else if (action === 2) { sourceCopy++; const d = decodeBPSVarInt(data, pos); pos = d.newOffset; }
        else if (action === 3) { targetCopy++; const d = decodeBPSVarInt(data, pos); pos = d.newOffset; }
        commands++;
      }
      info.commands = commands;
      info.commandBreakdown = { sourceRead, targetRead, sourceCopy, targetCopy };

      // Footer CRCs
      if (data.length >= 12) {
        const dv = new DataView(data.buffer, data.byteOffset + footerStart, 12);
        info.sourceCRC = dv.getUint32(0, true);
        info.targetCRC = dv.getUint32(4, true);
        info.patchCRC = dv.getUint32(8, true);
      }
      break;
    }
    case 'xdelta': {
      // VCDIFF header
      info.version = data[3];
      info.versionLabel = data[3] === 0x00 ? 'Standard (RFC 3284)' : data[3] === 0x53 ? 'xdelta3 (0x53)' : hex(data[3]);
      const hdrIndicator = data[4];
      info.headerIndicator = hdrIndicator;
      let pos = 5;

      // Secondary compression
      if (hdrIndicator & 0x01) {
        const compId = data[pos++];
        const compNames = { 0: 'none', 1: 'DJW', 2: 'LZMA', 16: 'FGK' };
        info.secondaryCompression = compNames[compId] || `ID=${compId}`;
      } else {
        info.secondaryCompression = 'none';
      }

      // Custom code table
      if (hdrIndicator & 0x02) {
        const ct = decodeVCDIFFInt(data, pos); pos = ct.newOffset + ct.value;
        info.hasCustomCodeTable = true;
      } else {
        info.hasCustomCodeTable = false;
      }

      // App header (xdelta3 extension)
      if (hdrIndicator & 0x04) {
        const ah = decodeVCDIFFInt(data, pos);
        pos = ah.newOffset;
        if (ah.value > 0 && pos + ah.value <= data.length) {
          info.appHeader = new TextDecoder('utf-8').decode(data.slice(pos, pos + ah.value)).replace(/\0+$/, '');
        }
        pos += ah.value;
      }

      // Walk windows
      let windows = 0, totalTargetSize = 0;
      let minWindowSize = Infinity, maxWindowSize = 0;
      let sourceWindows = 0;
      while (pos < data.length) {
        const winIndicator = data[pos++];
        const hasSource = !!(winIndicator & 0x01);
        const hasAdler32 = !!(winIndicator & 0x04);
        if (hasSource || (winIndicator & 0x02)) {
          const srcLen = decodeVCDIFFInt(data, pos); pos = srcLen.newOffset;
          const srcOff = decodeVCDIFFInt(data, pos); pos = srcOff.newOffset;
          if (hasSource) sourceWindows++;
        }
        const deltaLen = decodeVCDIFFInt(data, pos); pos = deltaLen.newOffset;
        const deltaEnd = pos + deltaLen.value;
        // Read target window length (first varint inside delta)
        const targetWindowLen = decodeVCDIFFInt(data, pos);
        totalTargetSize += targetWindowLen.value;
        if (targetWindowLen.value < minWindowSize) minWindowSize = targetWindowLen.value;
        if (targetWindowLen.value > maxWindowSize) maxWindowSize = targetWindowLen.value;
        pos = deltaEnd;
        windows++;
      }
      info.windows = windows;
      info.sourceWindows = sourceWindows;
      info.totalTargetSize = totalTargetSize;
      if (windows > 0) {
        info.minWindowSize = minWindowSize;
        info.maxWindowSize = maxWindowSize;
      }
      break;
    }
  }

  showDiagnoseProgress(1, 'Done');
  return info;
}

async function inspectUnknownFile(file) {
  showDiagnoseProgress(0.5, 'Reading file...');
  const dumpLen = Math.min(file.size, 64);
  const bytes = await readBytes(file, 0, dumpLen);
  showDiagnoseProgress(1, 'Done');
  return { fileSize: file.size, headerBytes: bytes };
}

// ── Hex dump helper ──────────────────────────────────────────────────────────

function hexDump(bytes) {
  let lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const addr = i.toString(16).padStart(4, '0');
    const hexParts = [];
    let ascii = '';
    for (let j = 0; j < 16; j++) {
      if (i + j < bytes.length) {
        hexParts.push(bytes[i + j].toString(16).padStart(2, '0'));
        const c = bytes[i + j];
        ascii += (c >= 0x20 && c <= 0x7E) ? String.fromCharCode(c) : '.';
      } else {
        hexParts.push('  ');
        ascii += ' ';
      }
    }
    lines.push(`${addr}  ${hexParts.slice(0,8).join(' ')}  ${hexParts.slice(8).join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

// ── Render new inspector results ─────────────────────────────────────────────

function renderCsoResults(r) {
  let summary = `<div class="diagnose-summary">${esc(r.format)} compressed disc image &mdash; ${formatSize(r.uncompressedSize)} uncompressed &mdash; ${r.ratio}% ratio</div>`;

  let body = '<table>';
  body += `<tr><td>Format</td><td>${esc(r.format)}</td></tr>`;
  body += `<tr><td>File size</td><td>${formatSize(r.fileSize)}</td></tr>`;
  body += `<tr><td>Uncompressed size</td><td>${formatSize(r.uncompressedSize)}</td></tr>`;
  body += `<tr><td>Block size</td><td>${formatSize(r.blockSize)} (<span class="hex">${hex(r.blockSize)}</span>)</td></tr>`;
  body += `<tr><td>Block count</td><td>${r.blockCount.toLocaleString()}</td></tr>`;
  body += `<tr><td>Compressed blocks</td><td>${r.compressedBlocks.toLocaleString()}</td></tr>`;
  body += `<tr><td>Stored blocks</td><td>${r.storedBlocks.toLocaleString()}</td></tr>`;
  body += `<tr><td>Compression ratio</td><td>${r.ratio}%</td></tr>`;
  body += '</table>';

  if (r.sampleResult) {
    body += '<div style="margin-top:0.4rem;color:#999;font-size:0.75rem">Sample decompress (block 0)</div><table>';
    const s = r.sampleResult;
    if (s.error) {
      body += `<tr><td>Result</td><td><span class="check-fail">FAIL</span> ${esc(s.error)}</td></tr>`;
    } else if (s.stored === 'uncompressed') {
      body += `<tr><td>Result</td><td>uncompressed, ${s.size} bytes</td></tr>`;
    } else {
      body += `<tr><td>Result</td><td>compressed ${s.compressedSize} &rarr; ${s.decompressedSize}${s.ok ? '' : ' <span class="check-fail">WRONG SIZE</span>'}</td></tr>`;
    }
    body += '</table>';
  }

  return summary + collapsibleSection('CSO Header', body, true);
}

function renderDiscResults(r) {
  const parts = ['Disc image'];
  if (r.discId) parts.push(r.discId);
  if (r.title) parts.push(r.title);
  parts.push(formatSize(r.fileSize));
  let summary = `<div class="diagnose-summary">${parts.map(esc).join(' &mdash; ')}</div>`;

  let body = '<table>';
  body += `<tr><td>File size</td><td>${formatSize(r.fileSize)}</td></tr>`;
  body += `<tr><td>Sector size</td><td>${r.sectorSize} bytes (${r.isRaw ? 'raw/2352' : 'ISO/2048'})</td></tr>`;
  body += `<tr><td>Sector count</td><td>${r.sectorCount.toLocaleString()}</td></tr>`;
  if (r.volumeId) body += `<tr><td>Volume ID</td><td>"${esc(r.volumeId)}"</td></tr>`;
  if (r.volumeSize) body += `<tr><td>Volume size</td><td>${r.volumeSize.toLocaleString()} blocks</td></tr>`;
  if (r.discId) body += `<tr><td>Disc ID</td><td>${esc(r.discId)}</td></tr>`;
  if (r.title) body += `<tr><td>Title</td><td>"${esc(r.title)}"</td></tr>`;
  body += '</table>';

  return summary + collapsibleSection('Disc Info', body, true);
}

function renderCueResults(r) {
  let summary = `<div class="diagnose-summary">CUE sheet &mdash; ${r.tracks.length} track${r.tracks.length !== 1 ? 's' : ''} &mdash; ${r.binNames.length} file${r.binNames.length !== 1 ? 's' : ''}</div>`;

  let body = '';
  if (r.binNames.length > 0) {
    body += '<div style="color:#999;font-size:0.75rem;margin-bottom:0.3rem">Referenced files</div><table>';
    for (const name of r.binNames) {
      body += `<tr><td>${esc(name)}</td></tr>`;
    }
    body += '</table>';
  }

  if (r.tracks.length > 0) {
    body += '<div style="color:#999;font-size:0.75rem;margin-top:0.4rem;margin-bottom:0.3rem">Tracks</div><table>';
    for (const t of r.tracks) {
      const idx01 = t.indexes.find(i => i.id === 1);
      const msf = idx01 ? `${String(idx01.msf[0]).padStart(2,'0')}:${String(idx01.msf[1]).padStart(2,'0')}:${String(idx01.msf[2]).padStart(2,'0')}` : '';
      body += `<tr><td>Track ${t.number}</td><td>${esc(t.type)}</td><td>${t.sectorSize} bytes/sector</td><td>${msf}</td></tr>`;
      if (t.pregap > 0) {
        body += `<tr><td></td><td colspan="3" style="color:#999">pregap: ${t.pregap} frames</td></tr>`;
      }
    }
    body += '</table>';
  }

  return summary + collapsibleSection('CUE Sheet', body, true);
}

function renderPatchResults(r) {
  const fmtNames = { ips: 'IPS', ppf: 'PPF', bps: 'BPS', xdelta: 'VCDIFF (xdelta)' };
  const name = fmtNames[r.format] || r.format;

  // Summary line
  let summaryParts = [name + ' patch', formatSize(r.fileSize)];
  if (r.records != null) summaryParts.push(r.records + ' record' + (r.records !== 1 ? 's' : ''));
  if (r.commands != null) summaryParts.push(r.commands + ' command' + (r.commands !== 1 ? 's' : ''));
  if (r.windows != null) summaryParts.push(r.windows + ' window' + (r.windows !== 1 ? 's' : ''));
  if (r.version != null && r.format === 'ppf') summaryParts.push('v' + r.version);
  if (r.totalTargetSize != null) summaryParts.push(formatSize(r.totalTargetSize) + ' output');
  let summary = `<div class="diagnose-summary">${summaryParts.map(esc).join(' &mdash; ')}</div>`;

  let body = '<table>';
  body += `<tr><td>Format</td><td>${esc(name)}</td></tr>`;
  body += `<tr><td>File size</td><td>${formatSize(r.fileSize)}</td></tr>`;

  // ── IPS-specific ──
  if (r.format === 'ips') {
    body += `<tr><td>Records</td><td>${r.records}${r.rleRecords ? ` (${r.rleRecords} RLE)` : ''}</td></tr>`;
    body += `<tr><td>Total data written</td><td>${formatSize(r.totalDataBytes)}</td></tr>`;
    if (r.patchedRange) {
      body += `<tr><td>Patched range</td><td><span class="hex">${hex(r.patchedRange.start)}</span> &ndash; <span class="hex">${hex(r.patchedRange.end)}</span> (${formatSize(r.patchedRange.end - r.patchedRange.start)})</td></tr>`;
    }
    if (r.hasTruncation) body += `<tr><td>Truncation</td><td>yes (output will be truncated)</td></tr>`;
  }

  // ── PPF-specific ──
  if (r.format === 'ppf') {
    body += `<tr><td>Version</td><td>${r.version}</td></tr>`;
    body += `<tr><td>Encoding</td><td>${esc(r.encoding)}</td></tr>`;
    if (r.description) body += `<tr><td>Description</td><td>"${esc(r.description)}"</td></tr>`;
    if (r.imageType) body += `<tr><td>Image type</td><td>${esc(r.imageType)}</td></tr>`;
    body += `<tr><td>Block check</td><td>${r.hasBlockCheck ? 'yes' : 'no'}</td></tr>`;
    if (r.hasUndo != null) body += `<tr><td>Undo data</td><td>${r.hasUndo ? 'yes' : 'no'}</td></tr>`;
    body += `<tr><td>Records</td><td>${r.records}</td></tr>`;
    body += `<tr><td>Total data written</td><td>${formatSize(r.totalDataBytes)}</td></tr>`;
  }

  // ── BPS-specific ──
  if (r.format === 'bps') {
    body += `<tr><td>Source size</td><td>${formatSize(r.sourceSize)}</td></tr>`;
    body += `<tr><td>Target size</td><td>${formatSize(r.targetSize)}</td></tr>`;
    if (r.metadataSize > 0) {
      body += `<tr><td>Metadata</td><td>${r.metadata ? '"' + esc(r.metadata) + '"' : formatSize(r.metadataSize)}</td></tr>`;
    }
    body += `<tr><td>Commands</td><td>${r.commands}</td></tr>`;
    if (r.commandBreakdown) {
      const cb = r.commandBreakdown;
      body += `<tr><td></td><td style="color:#999">SourceRead: ${cb.sourceRead}, TargetRead: ${cb.targetRead}, SourceCopy: ${cb.sourceCopy}, TargetCopy: ${cb.targetCopy}</td></tr>`;
    }
    if (r.sourceCRC != null) {
      body += `<tr><td>Source CRC32</td><td><span class="hex">${hex(r.sourceCRC)}</span></td></tr>`;
      body += `<tr><td>Target CRC32</td><td><span class="hex">${hex(r.targetCRC)}</span></td></tr>`;
      body += `<tr><td>Patch CRC32</td><td><span class="hex">${hex(r.patchCRC)}</span></td></tr>`;
    }
  }

  // ── VCDIFF-specific ──
  if (r.format === 'xdelta') {
    body += `<tr><td>Version</td><td>${esc(r.versionLabel)}</td></tr>`;
    body += `<tr><td>Secondary compression</td><td>${esc(r.secondaryCompression)}</td></tr>`;
    if (r.hasCustomCodeTable) body += `<tr><td>Custom code table</td><td>yes</td></tr>`;
    if (r.appHeader) body += `<tr><td>App header</td><td>"${esc(r.appHeader)}"</td></tr>`;
    body += `<tr><td>Windows</td><td>${r.windows}${r.sourceWindows ? ` (${r.sourceWindows} with source)` : ''}</td></tr>`;
    body += `<tr><td>Total output</td><td>${formatSize(r.totalTargetSize)}</td></tr>`;
    if (r.windows > 1) {
      body += `<tr><td>Window sizes</td><td>min ${formatSize(r.minWindowSize)}, max ${formatSize(r.maxWindowSize)}</td></tr>`;
    }
  }

  body += '</table>';
  return summary + collapsibleSection('Patch Info', body, true);
}

function renderUnknownResults(r) {
  let summary = `<div class="diagnose-summary">Unknown format &mdash; ${formatSize(r.fileSize)}</div>`;
  let body = `<div class="hex-dump">${esc(hexDump(r.headerBytes))}</div>`;
  return summary + collapsibleSection('Hex Dump (first 64 bytes)', body, true);
}

// ── Render EBOOT results (refactored with summary + sub-tabs) ────────────────

function renderEbootSummary(result) {
  const { sfo, psar } = result;
  const parts = ['EBOOT.PBP'];
  const titleEntry = sfo.entries && sfo.entries.find(e => e.key === 'TITLE');
  const discIdEntry = sfo.entries && sfo.entries.find(e => e.key === 'DISC_ID');
  if (discIdEntry) parts.push(String(discIdEntry.value));
  if (titleEntry) parts.push(String(titleEntry.value));
  parts.push(formatSize(result.fileSize));
  if (psar.discCount > 1) parts.push(psar.discCount + ' discs');
  return `<div class="diagnose-summary">${parts.map(esc).join(' &mdash; ')}</div>`;
}

function renderEbootResults(result) {
  const { pbp, sfo, psar } = result;

  // Build sub-tab content for PBP Header
  let pbpBody = '<table>';
  pbpBody += `<tr><td>Magic</td><td>${esc(pbp.magic)}</td></tr>`;
  pbpBody += `<tr><td>Version</td><td>${esc(pbp.version)}</td></tr>`;
  pbpBody += `<tr><td>File size</td><td>${formatSize(result.fileSize)}</td></tr>`;
  pbpBody += '</table><table style="margin-top:0.4rem">';
  for (const s of pbp.sections) {
    const status = s.empty ? '<span style="color:#666">(empty)</span>' : formatSize(s.size);
    pbpBody += `<tr><td>${esc(s.name)}</td><td><span class="hex">${hex(s.offset)}</span></td><td>${status}</td></tr>`;
  }
  pbpBody += '</table>';
  if (result.dataPspSha1) {
    pbpBody += `<div style="margin-top:0.3rem;font-size:0.75rem;color:#888">DATA.PSP SHA-1: <span class="hex">${esc(result.dataPspSha1)}</span></div>`;
  }

  // SFO content
  let sfoBody = '';
  if (sfo.error) {
    sfoBody = `<span class="check-fail">ERROR: ${esc(sfo.error)}</span>`;
  } else {
    sfoBody = '<table>';
    for (const e of sfo.entries) {
      const val = typeof e.value === 'number'
        ? `${e.value} (<span class="hex">${hex(e.value)}</span>)`
        : `"${esc(e.value)}"`;
      sfoBody += `<tr><td>${esc(e.key)}</td><td style="color:#888">[${esc(e.type)}]</td><td>${val}</td></tr>`;
    }
    sfoBody += '</table>';
  }

  // PSAR content
  let psarBody = renderPsarBody(psar);

  // Build sub-tabs
  let html = '<div class="diagnose-tabs" data-diagnose-tabs>';
  html += '<button class="active" data-dtab="header">Header</button>';
  html += '<button data-dtab="sfo">SFO</button>';
  html += '<button data-dtab="psar">PSAR</button>';
  html += '</div>';
  html += `<div class="diagnose-tab-panel active" data-dtab-panel="header">${collapsibleSection('PBP Header', pbpBody, true)}</div>`;
  html += `<div class="diagnose-tab-panel" data-dtab-panel="sfo">${collapsibleSection('PARAM.SFO', sfoBody, true)}</div>`;
  html += `<div class="diagnose-tab-panel" data-dtab-panel="psar">${collapsibleSection('DATA.PSAR', psarBody, true)}</div>`;

  return html;
}

function renderPsarBody(psar) {
  let psarBody = '<table>';
  psarBody += `<tr><td>Type</td><td>${esc(psar.type)}</td></tr>`;
  psarBody += `<tr><td>Discs</td><td>${psar.discCount}</td></tr>`;
  if (psar.discOffsets) {
    psarBody += `<tr><td>Offsets</td><td>${psar.discOffsets.map(hex).join(', ')}</td></tr>`;
  }
  psarBody += '</table>';

  for (const disc of (psar.discs || [])) {
    psarBody += `<div class="disc-separator">${esc(disc.label)}</div>`;
    if (disc.error) {
      psarBody += `<span class="check-fail">ERROR: ${esc(disc.error)}</span>`;
      continue;
    }

    psarBody += '<table>';
    psarBody += `<tr><td>Variant</td><td>${esc(disc.variant)}</td></tr>`;
    psarBody += `<tr><td>p1_offset</td><td><span class="hex">${hex(disc.p1_offset)}</span></td></tr>`;
    psarBody += `<tr><td>p2_offset</td><td><span class="hex">${hex(disc.p2_offset)}</span></td></tr>`;
    if (disc.discIdAt400) {
      psarBody += `<tr><td>Disc ID</td><td>"${esc(disc.discIdAt400)}"</td></tr>`;
    }
    psarBody += `<tr><td>Reserved</td><td>${disc.reservedAreaClean ? '<span class="check-pass">clean</span>' : `<span class="check-warn">${disc.reservedNonZeroBytes} non-zero bytes</span>`}</td></tr>`;
    psarBody += `<tr><td>Title</td><td>"${esc(disc.title)}"</td></tr>`;
    psarBody += '</table>';

    if (disc.toc.entryCount > 0) {
      psarBody += `<div style="margin-top:0.3rem;color:#999;font-size:0.75rem">TOC at +${hex(disc.tocOffset)}: ${disc.toc.entryCount} entries</div>`;
      psarBody += '<table>';
      for (const t of disc.toc.entries) {
        psarBody += `<tr><td>${esc(t.pointLabel)}</td><td>${esc(t.type)}</td><td>P=${esc(t.pmsf)}</td></tr>`;
      }
      psarBody += '</table>';
    }

    const idx = disc.indexTable;
    psarBody += `<div style="margin-top:0.3rem;color:#999;font-size:0.75rem">Index at +${hex(disc.indexOffset)}: ${idx.entryCount} blocks</div>`;
    if (idx.entryCount > 0) {
      psarBody += '<table>';
      psarBody += `<tr><td>First</td><td>offset=<span class="hex">${hex(idx.firstEntry.offset)}</span> len=${idx.firstEntry.length}</td></tr>`;
      psarBody += `<tr><td>Last</td><td>offset=<span class="hex">${hex(idx.lastEntry.offset)}</span> len=${idx.lastEntry.length}</td></tr>`;
      psarBody += `<tr><td>Block sizes</td><td>min=${idx.minBlockSize} max=${idx.maxBlockSize} (limit=<span class="hex">${hex(ISO_BLOCK_SIZE)}</span>)</td></tr>`;
      psarBody += `<tr><td>Compressed</td><td>${formatSize(idx.compressedTotal)}</td></tr>`;
      psarBody += `<tr><td>Uncompressed</td><td>${formatSize(idx.uncompressedTotal)}</td></tr>`;
      psarBody += `<tr><td>Ratio</td><td>${idx.ratio}</td></tr>`;
      psarBody += `<tr><td>Continuity</td><td>${idx.gaps === 0 && idx.overlaps === 0 ? '<span class="check-pass">contiguous</span>' : `<span class="check-warn">${idx.gaps} gaps, ${idx.overlaps} overlaps</span>`}</td></tr>`;
      psarBody += `<tr><td>Block hashes</td><td>${idx.hashedEntries}/${idx.entryCount}</td></tr>`;
      psarBody += '</table>';
    }

    if (disc.btypes) {
      const bt = disc.btypes;
      const total = bt.fixed + bt.dynamic + bt.stored + bt.raw;
      if (total > 0) {
        psarBody += '<div style="margin-top:0.3rem;color:#999;font-size:0.75rem">Compression BTYPE</div><table>';
        psarBody += `<tr><td>Dynamic Huffman</td><td>${bt.dynamic}</td></tr>`;
        psarBody += `<tr><td>Fixed Huffman</td><td>${bt.fixed}</td></tr>`;
        psarBody += `<tr><td>Stored (deflate)</td><td>${bt.stored}</td></tr>`;
        psarBody += `<tr><td>Uncompressed (raw)</td><td>${bt.raw}</td></tr>`;
        psarBody += '</table>';
      }
    }

    if (disc.startdatOffset != null) {
      psarBody += `<div style="margin-top:0.3rem"><span style="color:#999;font-size:0.75rem">STARTDAT at +${hex(disc.startdatOffset)}</span> magic="${esc(disc.startdatMagic || 'N/A')}"</div>`;
    }

    if (disc.samples.length > 0) {
      psarBody += '<div style="margin-top:0.3rem;color:#999;font-size:0.75rem">Sample decompress</div><table>';
      for (const s of disc.samples) {
        if (s.error) {
          psarBody += `<tr><td>Block ${s.block}</td><td><span class="check-fail">FAIL</span> ${esc(s.error)}</td></tr>`;
        } else {
          const sizeOk = s.ok !== false;
          psarBody += `<tr><td>Block ${s.block}</td><td>${esc(s.stored)} ${s.compressedSize} &rarr; ${s.decompressedSize}${sizeOk ? '' : ' <span class="check-fail">WRONG SIZE</span>'}</td></tr>`;
        }
      }
      psarBody += '</table>';
    }

    const c = disc.sanityChecks;
    psarBody += '<div style="margin-top:0.4rem;color:#999;font-size:0.75rem">Sanity checks</div><table>';
    psarBody += `<tr><td>p1</td><td>${badge(c.p1_matches, c.p1_matches ? 'OK' : `got ${hex(disc.p1_offset)}, expected ${hex(c.p1_compressed)} or ${hex(c.p1_uncompressed)}`)}</td></tr>`;
    psarBody += `<tr><td>p2</td><td>${badge(c.p2_matches, c.p2_matches ? '0' : `got ${hex(disc.p2_offset)}`)}</td></tr>`;
    psarBody += `<tr><td>First idx</td><td>${badge(c.firstIndexOffsetZero, 'offset == 0')}</td></tr>`;
    psarBody += `<tr><td>Block range</td><td>${badge(c.allBlocksInRange, 'all <= 0x9300')}</td></tr>`;
    psarBody += '</table>';
  }

  return psarBody;
}

// ── Render inspect results as HTML ───────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badge(pass, text) {
  const cls = pass ? 'check-pass' : 'check-fail';
  return `<span class="${cls}">${pass ? 'PASS' : 'FAIL'}</span> ${esc(text)}`;
}

function collapsibleSection(title, bodyHTML, startOpen) {
  const arrowCls = startOpen ? 'arrow' : 'arrow collapsed';
  const bodyCls = startOpen ? 'section-body' : 'section-body collapsed';
  return `<div class="section">
    <div class="section-header"><span class="${arrowCls}">&#9660;</span> ${esc(title)}</div>
    <div class="${bodyCls}">${bodyHTML}</div>
  </div>`;
}

// renderInspectResults replaced by renderEbootResults + renderEbootSummary above

function initCollapsibles() {
  for (const header of diagnoseResults.querySelectorAll('.section-header')) {
    header.addEventListener('click', () => {
      const arrow = header.querySelector('.arrow');
      const body = header.nextElementSibling;
      arrow.classList.toggle('collapsed');
      body.classList.toggle('collapsed');
    });
  }
}

function initDiagnoseTabs() {
  const tabBar = diagnoseResults.querySelector('[data-diagnose-tabs]');
  if (!tabBar) return;
  for (const btn of tabBar.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.dtab;
      for (const b of tabBar.querySelectorAll('button')) b.classList.toggle('active', b === btn);
      for (const p of diagnoseResults.querySelectorAll('[data-dtab-panel]')) {
        p.classList.toggle('active', p.dataset.dtabPanel === tabId);
      }
    });
  }
}
