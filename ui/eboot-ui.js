// ══════════════════════════════════════════════════════════════════════════════
// EBOOT TAB — PS1 disc image → EBOOT.PBP builder
//
// Handles the "EBOOT" tab UI: disc image drop zone, multi-disc management,
// CUE/BIN pairing, game title/disc ID detection, artwork previews, compression
// settings, parallel worker dispatch, progress display, and ZIP download.
//
// Build pipeline:
//   1. User drops BIN/ISO/CUE files → auto-detect disc ID and title
//   2. Read disc images into ISO_BLOCK_SIZE chunks
//   3. Dispatch chunks to compress-worker.js instances (parallel deflate)
//   4. Send compressed data to eboot-worker.js (assembles PBP)
//   5. Download result as EBOOT.PBP inside a ZIP
// ══════════════════════════════════════════════════════════════════════════════

const ebootDropZone = document.getElementById('ebootDropZone');
const ebootFileInput = document.getElementById('ebootFileInput');
const ebootFileInfo = document.getElementById('ebootFileInfo');
const ebootFileName = document.getElementById('ebootFileName');
const ebootFileMeta = document.getElementById('ebootFileMeta');
const ebootActionsEl = document.getElementById('ebootActions');
const discListEl = document.getElementById('discList');
const addDiscHint = document.getElementById('addDiscHint');
const ebootOpts = document.getElementById('ebootOpts');
const ebootTitle = document.getElementById('ebootTitle');
const ebootDiscId = document.getElementById('ebootDiscId');
const ebootCompression = document.getElementById('ebootCompression');
const ebootCompressionVal = document.getElementById('ebootCompressionVal');
const ebootCompressionLabel = document.getElementById('ebootCompressionLabel');
const ebootThreads = document.getElementById('ebootThreads');
const ebootThreadsVal = document.getElementById('ebootThreadsVal');
const discIdDetected = document.getElementById('discIdDetected');
const ebootProgressArea = document.getElementById('ebootProgressArea');
const ebootProgressFill = document.getElementById('ebootProgressFill');
const ebootProgressLabel = document.getElementById('ebootProgressLabel');
const ebootProgressPct = document.getElementById('ebootProgressPct');
const ebootStatusEl = document.getElementById('ebootStatus');
const artIcon0 = document.getElementById('artIcon0');
const artPic0 = document.getElementById('artPic0');
const artPic1 = document.getElementById('artPic1');

let ebootFiles = [];
let pendingCues = [];
let ebootWorking = false;
let ebootActiveWorker = null;
let ebootActiveCompressWorkers = [];
const ebootCancelBtn = document.getElementById('ebootCancelBtn');

const ebootParentalLevel = document.getElementById('ebootParentalLevel');
const ebootRegion = document.getElementById('ebootRegion');
const ebootFetchArt = document.getElementById('ebootFetchArt');

// Persist fetch-artwork checkbox via localStorage
try { ebootFetchArt.checked = localStorage.getItem('fetchArtwork') === 'true'; } catch {}
ebootFetchArt.addEventListener('change', () => {
  try { localStorage.setItem('fetchArtwork', ebootFetchArt.checked); } catch {}
  scheduleArtworkRegenerate();
});

// Elements to disable during build
const ebootInputs = [ebootTitle, ebootDiscId, ebootCompression, ebootThreads, ebootParentalLevel, ebootRegion, ebootFetchArt];

function setEbootInputsDisabled(disabled) {
  for (const el of ebootInputs) el.disabled = disabled;
  ebootDropZone.style.pointerEvents = disabled ? 'none' : '';
  ebootDropZone.style.opacity = disabled ? '0.5' : '';
  if (discListEl) {
    discListEl.style.pointerEvents = disabled ? 'none' : '';
    discListEl.style.opacity = disabled ? '0.5' : '';
  }
}

ebootCancelBtn.addEventListener('click', () => {
  if (!ebootWorking) return;
  if (!confirm('Cancel the current build?')) return;
  // Terminate all active workers
  if (ebootActiveWorker) { ebootActiveWorker.terminate(); ebootActiveWorker = null; }
  for (const w of ebootActiveCompressWorkers) w.terminate();
  ebootActiveCompressWorkers = [];
  ebootWorking = false;
  setEbootInputsDisabled(false);
  for (const btn of ebootActionsEl.querySelectorAll('button')) btn.disabled = false;
  ebootStatusEl.textContent = 'Build cancelled';
  ebootStatusEl.className = 'status';
  ebootProgressArea.style.display = 'none';
});

const compressionLabels = ['None', 'Low', 'Low', 'Medium', 'Medium', 'High', 'High', 'Very high', 'Very high', 'Maximum'];
function updateCompressionLabel() {
  const v = parseInt(ebootCompression.value, 10);
  ebootCompressionVal.textContent = v;
  ebootCompressionLabel.textContent = compressionLabels[v];
}
updateCompressionLabel();
ebootCompression.addEventListener('input', updateCompressionLabel);
ebootThreadsVal.textContent = ebootThreads.value;
ebootThreads.addEventListener('input', () => {
  ebootThreadsVal.textContent = ebootThreads.value;
});

// Artwork: click preview → open file picker
artIcon0.addEventListener('click', () => document.getElementById('artIcon0Input').click());
artPic0.addEventListener('click', () => document.getElementById('artPic0Input').click());
artPic1.addEventListener('click', () => document.getElementById('artPic1Input').click());

document.getElementById('artIcon0Input').addEventListener('change', async function() {
  if (!this.files[0]) return;
  currentIcon0 = await resizeImageToUint8Array(this.files[0], 144, 80);
  artIcon0.src = URL.createObjectURL(new Blob([currentIcon0], { type: 'image/png' }));
  icon0IsCustom = true;
  document.getElementById('artIcon0Reset').style.display = 'inline';
  this.value = '';
});
document.getElementById('artPic0Input').addEventListener('change', async function() {
  if (!this.files[0]) return;
  currentPic0 = await resizeImageToUint8Array(this.files[0], 310, 180);
  artPic0.src = URL.createObjectURL(new Blob([currentPic0], { type: 'image/png' }));
  pic0IsCustom = true;
  document.getElementById('artPic0Reset').style.display = 'inline';
  this.value = '';
});
document.getElementById('artPic1Input').addEventListener('change', async function() {
  if (!this.files[0]) return;
  currentPic1 = await resizeImageToUint8Array(this.files[0], 480, 272);
  artPic1.src = URL.createObjectURL(new Blob([currentPic1], { type: 'image/png' }));
  pic1IsCustom = true;
  document.getElementById('artPic1Reset').style.display = 'inline';
  this.value = '';
});

document.getElementById('artIcon0Reset').addEventListener('click', async () => {
  icon0IsCustom = false;
  document.getElementById('artIcon0Reset').style.display = 'none';
  await regenerateDefaults();
});
document.getElementById('artPic0Reset').addEventListener('click', async () => {
  pic0IsCustom = false;
  document.getElementById('artPic0Reset').style.display = 'none';
  await regenerateDefaults();
});
document.getElementById('artPic1Reset').addEventListener('click', async () => {
  pic1IsCustom = false;
  document.getElementById('artPic1Reset').style.display = 'none';
  await regenerateDefaults();
});

let artworkDebounce = null;
function scheduleArtworkRegenerate() {
  clearTimeout(artworkDebounce);
  artworkDebounce = setTimeout(() => {
    if (ebootOpts.style.display !== 'none') regenerateDefaults();
  }, 300);
}
ebootTitle.addEventListener('input', scheduleArtworkRegenerate);
ebootDiscId.addEventListener('input', scheduleArtworkRegenerate);

// Drop zone
ebootDropZone.addEventListener('click', () => ebootFileInput.click());
ebootDropZone.addEventListener('dragover', e => { e.preventDefault(); ebootDropZone.classList.add('dragover'); });
ebootDropZone.addEventListener('dragleave', () => ebootDropZone.classList.remove('dragover'));
ebootDropZone.addEventListener('drop', e => {
  e.preventDefault();
  ebootDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleEbootDrop(e.dataTransfer.files);
});
ebootFileInput.addEventListener('change', () => {
  if (ebootFileInput.files.length) handleEbootDrop(ebootFileInput.files);
  ebootFileInput.value = '';
});

async function handleEbootDrop(fileList) {
  if (ebootWorking) return;

  const allFiles = Array.from(fileList);
  const cueFiles = allFiles.filter(f => f.name.toLowerCase().endsWith('.cue'));
  const nonCueFiles = allFiles.filter(f => !f.name.toLowerCase().endsWith('.cue'));

  // If we're already in multi-disc mode and more files are dropped, add them
  if (ebootFiles.length > 0) {
    await addDiscFiles(cueFiles, nonCueFiles);
    return;
  }

  // If only CUE files dropped, parse them and wait for BINs
  if (cueFiles.length > 0 && nonCueFiles.length === 0) {
    await startPS1WithCues(cueFiles);
    return;
  }

  // If CUEs + BINs dropped together, pair them up
  if (cueFiles.length > 0 && nonCueFiles.length > 0) {
    await startPS1WithCuesAndBins(cueFiles, nonCueFiles);
    return;
  }

  // No CUEs — just BIN files
  resetEbootUI();
  ebootFiles = nonCueFiles.slice(0, 5).map(f => ({ file: f, cueText: null, cueTracks: null }));
  sortEbootFiles();
  renderDiscList();
  addDiscHint.style.display = 'block';

  const file = ebootFiles[0]?.file;
  if (file) {
    ebootFileName.textContent = file.name;
    ebootFileMeta.innerHTML = formatSize(file.size) + ' <span class="format-label format-ps1">PS1 Disc</span>';
    ebootFileInfo.style.display = 'block';

    showEbootActions();

    const detected = await autoDetectDiscId(file);
    if (detected?.discId) {
      ebootDiscId.value = detected.discId;
      discIdDetected.textContent = '(auto-detected)';
    } else {
      ebootDiscId.value = '';
      discIdDetected.textContent = '';
    }
    if (detected?.title) {
      ebootTitle.value = detected.title;
    }
    regenerateDefaults();
  }
}

function resetEbootUI() {
  ebootStatusEl.textContent = '';
  ebootStatusEl.className = 'status';
  ebootProgressArea.style.display = 'none';
  ebootOpts.style.display = 'none';
  discListEl.innerHTML = '';
  addDiscHint.style.display = 'none';
  document.getElementById('buildLogArea').style.display = 'none';
  ebootFiles = [];
  pendingCues = [];
  icon0IsCustom = pic0IsCustom = pic1IsCustom = false;
  currentIcon0 = currentPic0 = currentPic1 = null;
  artIcon0.src = '';
  artPic0.src = '';
  artPic1.src = '';
  document.getElementById('artIcon0Reset').style.display = 'none';
  document.getElementById('artPic0Reset').style.display = 'none';
  document.getElementById('artPic1Reset').style.display = 'none';
}

function showEbootActions() {
  ebootActionsEl.innerHTML = '';
  const ebootBtn = document.createElement('button');
  ebootBtn.className = 'btn-eboot';
  ebootBtn.dataset.testid = 'eboot-build-btn';
  ebootBtn.textContent = 'Build EBOOT.PBP';
  ebootBtn.addEventListener('click', startEbootBuild);
  ebootActionsEl.appendChild(ebootBtn);
  ebootActionsEl.style.display = 'flex';
  ebootOpts.style.display = 'block';
  regenerateDefaults();
}

function findBinFile(binName, files) {
  const target = binName.split(/[/\\]/).pop().toLowerCase();
  return files.find(f => f.name.toLowerCase() === target);
}

function sortEbootFiles() {
  ebootFiles.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
}

async function startPS1WithCues(cueFiles) {
  resetEbootUI();
  pendingCues = [];

  for (const cf of cueFiles) {
    const cueText = await cf.text();
    const binNames = extractBinNames(cueText);
    const tracks = parseCueTracksUI(cueText);
    if (binNames.length === 0) binNames.push(cf.name.replace(/\.cue$/i, '.bin'));
    pendingCues.push({ name: cf.name, cueText, cueTracks: tracks, binNames });
  }

  ebootFileInfo.style.display = 'block';
  ebootFileName.textContent = pendingCues.map(c => c.name).join(', ');
  ebootFileMeta.innerHTML = '<span class="format-label format-ps1">PS1 Disc</span>';

  const allNeeded = pendingCues.flatMap(c => c.binNames);
  ebootStatusEl.textContent = 'Missing: ' + allNeeded.join(', ') + ' \u2014 drop the file(s) to continue';
  ebootStatusEl.className = 'status';

  addDiscHint.style.display = 'block';
  addDiscHint.textContent = 'Drop the BIN file(s) referenced by the CUE sheet(s)';
}

async function startPS1WithCuesAndBins(cueFiles, binFiles) {
  resetEbootUI();

  const consumedBins = new Set();

  for (const cf of cueFiles) {
    const cueText = await cf.text();
    const binNames = extractBinNames(cueText);
    const tracks = parseCueTracksUI(cueText);
    if (binNames.length === 0) binNames.push(cf.name.replace(/\.cue$/i, '.bin'));
    const result = mergeCueBins(binNames, binFiles);

    if (result) {
      if (ebootFiles.length < 5) {
        ebootFiles.push({ file: result.merged, cueText, cueTracks: tracks, fileSizes: result.fileSizes });
      }
      result.matched.forEach(f => consumedBins.add(f));
    } else {
      pendingCues.push({ name: cf.name, cueText, cueTracks: tracks, binNames });
    }
  }

  for (const bf of binFiles) {
    if (!consumedBins.has(bf) && ebootFiles.length < 5) {
      ebootFiles.push({ file: bf, cueText: null, cueTracks: null, fileSizes: null });
    }
  }

  sortEbootFiles();

  const firstFile = ebootFiles[0]?.file;
  if (firstFile) {
    ebootFileInfo.style.display = 'block';
    ebootFileName.textContent = firstFile.name;
    ebootFileMeta.innerHTML = formatSize(firstFile.size) + ' <span class="format-label format-ps1">PS1 Disc</span>';
  }

  renderDiscList();

  if (pendingCues.length > 0) {
    ebootStatusEl.textContent = 'Missing: ' + pendingCues.map(c => c.binName).join(', ') + ' \u2014 drop to continue';
    ebootStatusEl.className = 'status';
    addDiscHint.style.display = 'block';
    addDiscHint.textContent = 'Drop the missing BIN file(s) to continue';
  } else {
    addDiscHint.style.display = 'block';
    addDiscHint.textContent = 'Drop more discs to add them (up to 5)';
    showEbootActions();

    if (firstFile) {
      const detected = await autoDetectDiscId(firstFile);
      if (detected?.discId) {
        ebootDiscId.value = detected.discId;
        discIdDetected.textContent = '(auto-detected)';
      } else {
        ebootDiscId.value = '';
        discIdDetected.textContent = '';
      }
      if (detected?.title) {
        ebootTitle.value = detected.title;
      }
      regenerateDefaults();
    }
  }
}

async function addDiscFiles(cueFiles, binFiles) {
  const consumedBins = new Set();

  for (let i = pendingCues.length - 1; i >= 0; i--) {
    const cue = pendingCues[i];
    const result = mergeCueBins(cue.binNames, binFiles);
    if (result) {
      pendingCues.splice(i, 1);
      if (ebootFiles.length < 5) {
        ebootFiles.push({ file: result.merged, cueText: cue.cueText, cueTracks: cue.cueTracks, fileSizes: result.fileSizes });
      }
      result.matched.forEach(f => consumedBins.add(f));
    }
  }

  for (const cf of cueFiles) {
    const cueText = await cf.text();
    const binNames = extractBinNames(cueText);
    const tracks = parseCueTracksUI(cueText);
    if (binNames.length === 0) binNames.push(cf.name.replace(/\.cue$/i, '.bin'));
    const result = mergeCueBins(binNames, binFiles);

    if (result) {
      if (ebootFiles.length < 5) {
        ebootFiles.push({ file: result.merged, cueText, cueTracks: tracks, fileSizes: result.fileSizes });
      }
      result.matched.forEach(f => consumedBins.add(f));
    } else {
      pendingCues.push({ name: cf.name, cueText, cueTracks: tracks, binNames });
    }
  }

  for (const bf of binFiles) {
    if (!consumedBins.has(bf) && ebootFiles.length < 5) {
      ebootFiles.push({ file: bf, cueText: null, cueTracks: null, fileSizes: null });
    }
  }

  sortEbootFiles();
  renderDiscList();

  if (pendingCues.length > 0) {
    const allNeeded = pendingCues.flatMap(c => c.binNames);
    ebootStatusEl.textContent = 'Missing: ' + allNeeded.join(', ') + ' \u2014 drop to continue';
    ebootStatusEl.className = 'status';
    addDiscHint.textContent = 'Drop the missing BIN file(s) to continue';
  } else {
    ebootStatusEl.textContent = '';
    ebootStatusEl.className = 'status';
    addDiscHint.textContent = 'Drop more discs to add them (up to 5)';

    if (!ebootActionsEl.querySelector('.btn-eboot')) {
      showEbootActions();

      const firstFile = ebootFiles[0]?.file;
      if (firstFile) {
        ebootFileInfo.style.display = 'block';
        ebootFileName.textContent = firstFile.name;
        ebootFileMeta.innerHTML = formatSize(firstFile.size) + ' <span class="format-label format-ps1">PS1 Disc</span>';
        const detected = await autoDetectDiscId(firstFile);
        if (detected?.discId) {
          ebootDiscId.value = detected.discId;
          discIdDetected.textContent = '(auto-detected)';
        }
        if (detected?.title) {
          ebootTitle.value = detected.title;
        }
        regenerateDefaults();
      }
    }
  }
}

let dragSrcIdx = null;

function renderDiscList() {
  discListEl.innerHTML = '';
  if (ebootFiles.length <= 1 && pendingCues.length === 0) return;
  ebootFiles.forEach((entry, i) => {
    const f = entry.file;
    const item = document.createElement('div');
    item.className = 'disc-item';
    item.draggable = true;
    item.dataset.idx = i;
    const cueLabel = entry.cueText ? ' <span class="detected">(CUE)</span>' : '';
    item.innerHTML = `<span class="disc-num">${i+1}</span><span class="disc-name">${f.name}${cueLabel}</span><span class="disc-size">${formatSize(f.size)}</span>`;

    item.addEventListener('dragstart', (e) => {
      dragSrcIdx = i;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dragSrcIdx = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (dragSrcIdx !== null && dragSrcIdx !== i) {
        const [moved] = ebootFiles.splice(dragSrcIdx, 1);
        ebootFiles.splice(i, 0, moved);
        renderDiscList();
      }
    });

    const rm = document.createElement('button');
    rm.className = 'disc-remove';
    rm.textContent = '\u00d7';
    rm.addEventListener('click', () => {
      ebootFiles.splice(i, 1);
      renderDiscList();
    });
    item.appendChild(rm);
    discListEl.appendChild(item);
  });
  pendingCues.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'disc-item';
    item.style.opacity = '0.5';
    item.innerHTML = `<span class="disc-num">?</span><span class="disc-name">${c.binName} <span style="color:#ff6b6b">(missing)</span></span><span class="disc-size">${c.name}</span>`;
    discListEl.appendChild(item);
  });
}

function showEbootProgress(pct, label) {
  const p = Math.round(pct * 100);
  ebootProgressFill.style.width = p + '%';
  ebootProgressPct.textContent = p + '%';
  ebootProgressLabel.textContent = label;
}

// ── Build log formatting ─────────────────────────────────────────────────────
function formatBuildLog(log) {
  const lines = [];
  lines.push('EBOOT Build Log');
  lines.push('===============');
  lines.push('Date: ' + new Date().toISOString());
  lines.push('Total time: ' + (log.timing.total / 1000).toFixed(1) + 's');
  lines.push('');

  lines.push('Input Files');
  lines.push('-----------');
  for (let i = 0; i < log.inputFiles.length; i++) {
    const f = log.inputFiles[i];
    lines.push('Disc ' + (i + 1) + ': ' + f.filename);
    lines.push('  Size: ' + f.size.toLocaleString() + ' bytes (' + formatSize(f.size) + ')');
    lines.push('  SHA-1: ' + f.sha1);
    lines.push('  Sector size: ' + f.sectorSize + (f.sectorSize === 2352 ? ' (raw)' : ' (ISO)'));
    lines.push('  Disc ID: ' + f.discId);
    lines.push('  CUE: ' + (f.hasCue ? 'yes (' + f.trackCount + ' track' + (f.trackCount > 1 ? 's' : '') + ')' : 'no'));
    lines.push('');
  }

  lines.push('Settings');
  lines.push('--------');
  lines.push('Title: ' + log.sfo.title);
  lines.push('Compression level: ' + log.compressionLevel);
  lines.push('Disc count: ' + log.sfo.discTotal);
  lines.push('');

  lines.push('Compression');
  lines.push('-----------');
  for (let i = 0; i < log.discStats.length; i++) {
    const s = log.discStats[i];
    lines.push('Disc ' + (i + 1) + ': ' + s.totalBlocks.toLocaleString() + ' blocks');
    const compPct = s.totalBlocks > 0 ? (s.compressedCount / s.totalBlocks * 100).toFixed(1) : '0.0';
    const uncompPct = s.totalBlocks > 0 ? (s.uncompressedCount / s.totalBlocks * 100).toFixed(1) : '0.0';
    lines.push('  Compressed: ' + s.compressedCount.toLocaleString() + ' (' + compPct + '%)');
    lines.push('  Uncompressed: ' + s.uncompressedCount.toLocaleString() + ' (' + uncompPct + '%)');
    lines.push('  Input: ' + s.inputSize.toLocaleString() + ' bytes');
    lines.push('  Output: ' + s.outputSize.toLocaleString() + ' bytes');
    const ratio = s.inputSize > 0 ? (s.outputSize / s.inputSize * 100).toFixed(1) : '0.0';
    lines.push('  Ratio: ' + ratio + '%');
    lines.push('');
  }

  lines.push('Timing');
  lines.push('------');
  lines.push('SFO: ' + (log.timing.sfo / 1000).toFixed(3) + 's');
  lines.push('PSAR (compression): ' + (log.timing.psar / 1000).toFixed(1) + 's');
  lines.push('PBP assembly: ' + (log.timing.pbp / 1000).toFixed(3) + 's');
  lines.push('');

  if (log.verification) {
    lines.push('Verification');
    lines.push('------------');
    for (const v of log.verification) {
      lines.push('[' + v.status + '] ' + v.message);
    }
    lines.push('');
  }

  lines.push('Output');
  lines.push('------');
  lines.push('EBOOT.PBP: ' + log.outputSize.toLocaleString() + ' bytes (' + formatSize(log.outputSize) + ')');

  return lines.join('\n');
}

function showBuildLogDownload(log) {
  const text = formatBuildLog(log);
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.getElementById('buildLogLink');
  link.href = url;
  const id = ebootDiscId.value.trim() || 'SLUS00000';
  link.download = `eboot-build-log-${id}.txt`;
  document.getElementById('buildLogArea').style.display = 'block';
}

// ── Parallel compression ─────────────────────────────────────────────────────
// ISO_BLOCK_SIZE (0x9300) is declared in shared.js

async function compressDiscParallel(file, compressionLevel, numThreads, onProgress) {
  const fileSize = file.size;
  const totalBlocks = Math.ceil(fileSize / ISO_BLOCK_SIZE);

  // Read all blocks from file
  onProgress(0, 'Reading disc image...');
  const allBlocks = [];
  for (let i = 0; i < totalBlocks; i++) {
    const start = i * ISO_BLOCK_SIZE;
    const end = Math.min(start + ISO_BLOCK_SIZE, fileSize);
    allBlocks.push(new Uint8Array(await file.slice(start, end).arrayBuffer()));
    if (i % 64 === 0) {
      onProgress(i / totalBlocks * 0.3, `Reading block ${i}/${totalBlocks}`);
    }
  }

  onProgress(0.3, 'Compressing...');

  const createWorker = () => {
    const worker = new Worker('compress-worker.js');
    ebootActiveCompressWorkers.push(worker);
    return worker;
  };
  const doneMessages = await runWorkerPool(createWorker, allBlocks, numThreads, {
    message: (blocks) => ({ blocks, compressionLevel }),
    transfer: (blocks) => blocks.map(b => b.buffer),
    onProgress: (fraction, workerCount) => {
      onProgress(0.3 + fraction * 0.65, `Compressing... (${workerCount} workers)`);
    },
  });
  // Convert transferred ArrayBuffers back to Uint8Arrays
  const workerResults = doneMessages.map(done => ({
    parts: done.parts.map(p => new Uint8Array(p.buffer || p)),
    indexEntries: done.indexEntries,
    stats: done.stats,
  }));

  // Stitch results — adjust offsets for ranges after the first
  const allParts = [];
  const allIndexEntries = [];
  let runningOffset = 0;
  let totalCompressedCount = 0;
  let totalUncompressedCount = 0;
  let totalCompressedBytes = 0;

  for (const wr of workerResults) {
    for (const part of wr.parts) allParts.push(part);
    for (const entry of wr.indexEntries) {
      allIndexEntries.push({
        offset: entry.offset + runningOffset,
        size: entry.size,
        sha1: entry.sha1,
      });
    }
    runningOffset += wr.stats.totalCompressedBytes;
    totalCompressedCount += wr.stats.compressedCount;
    totalUncompressedCount += wr.stats.uncompressedCount;
    totalCompressedBytes += wr.stats.totalCompressedBytes;
  }

  onProgress(0.95, 'Compression complete');
  return {
    parts: allParts,
    indexEntries: allIndexEntries,
    stats: {
      compressedCount: totalCompressedCount,
      uncompressedCount: totalUncompressedCount,
      totalCompressedBytes,
    },
  };
}

// ── EBOOT build ──────────────────────────────────────────────────────────────
async function startEbootBuild() {
  if (ebootWorking || !ebootFiles.length || pendingCues.length > 0) return;

  const title = ebootTitle.value.trim() || 'Unknown';
  const discId = ebootDiscId.value.trim() || 'SLUS00000';
  const compressionLevel = parseInt(ebootCompression.value, 10);
  const numThreads = parseInt(ebootThreads.value, 10);
  const parentalLevel = parseInt(ebootParentalLevel.value, 10);
  const region = parseInt(ebootRegion.value, 16);

  const discIds = ebootFiles.map((_, i) => {
    if (i === 0) return discId;
    const base = discId.slice(0, -1);
    const last = parseInt(discId.slice(-1), 10);
    return base + ((last + i) % 10);
  });

  const discInfo = ebootFiles.map(entry => {
    if (entry.cueTracks && entry.cueTracks.length > 0) {
      return {
        tracks: entry.cueTracks,
        fileSize: entry.file.size,
        sectorSize: entry.cueTracks[0].sectorSize,
        fileSizes: entry.fileSizes || null,
      };
    }
    return null;
  });

  ebootWorking = true;
  ebootActiveCompressWorkers = [];
  for (const btn of ebootActionsEl.querySelectorAll('button')) btn.disabled = true;
  setEbootInputsDisabled(true);
  ebootProgressArea.style.display = 'block';
  showEbootProgress(0, 'Starting...');
  ebootStatusEl.textContent = '';
  ebootStatusEl.className = 'status';

  const t0 = performance.now();

  // Parallel compression: compress blocks on main thread, then send to eboot-worker for assembly
  let preCompressed = undefined;
  if (numThreads > 1) {
    try {
      preCompressed = [];
      const files = ebootFiles.map(e => e.file);
      for (let d = 0; d < files.length; d++) {
        const discProgress = (pct, label) => {
          const overall = (d + pct) / files.length;
          showEbootProgress(overall * 0.90, `Disc ${d + 1}/${files.length}: ${label}`);
        };
        const result = await compressDiscParallel(files[d], compressionLevel, numThreads, discProgress);
        preCompressed.push(result);
      }
    } catch (err) {
      ebootStatusEl.textContent = `Error: ${err.message}`;
      ebootStatusEl.className = 'status error';
      ebootWorking = false;
      setEbootInputsDisabled(false);
      for (const btn of ebootActionsEl.querySelectorAll('button')) btn.disabled = false;
      return;
    }
  }

  const worker = new Worker('eboot-worker.js');
  ebootActiveWorker = worker;

  const files = ebootFiles.map(e => e.file);
  const icon0 = currentIcon0 || undefined;
  const pic0 = currentPic0 || undefined;
  const pic1 = currentPic1 || undefined;
  let done;
  try {
    done = await runWorker(worker, { files, title, discIds, compressionLevel, parentalLevel, region, discInfo, icon0, pic0, pic1, preCompressed }, {
      onProgress: (msg) => {
        if (preCompressed) {
          // Scale assembly progress into 90-96% (leave room for zip packaging)
          const scaled = 0.90 + msg.pct * 0.06;
          showEbootProgress(Math.min(scaled, 0.96), msg.label);
        } else {
          // Cap at 96% — zip packaging takes the remaining 4%
          showEbootProgress(Math.min(msg.pct * 0.96, 0.96), msg.label);
        }
      },
    });
  } catch (err) {
    // A crash's message already reads "Worker error: ..."
    ebootStatusEl.textContent = err.workerMessage ? `Error: ${err.message}` : err.message;
    ebootStatusEl.className = 'status error';
    if (err.workerMessage?.buildLog) showBuildLogDownload(err.workerMessage.buildLog);
    finishEbootBuild();
    return;
  }

  showEbootProgress(0.97, 'Packaging ZIP...');
  const ebootResult = new Uint8Array(done.result);
  const ebootSize = ebootResult.length;
  const zipPath = discId + '/EBOOT.PBP';
  try {
    const zipData = await createZipInWorker([{ name: zipPath, data: ebootResult }], (phase) => {
      const step = phase === 'crc' ? 'Checksumming' : phase === 'alloc' ? 'Allocating' : 'Copying';
      showEbootProgress(0.97, `Packaging ZIP \u2014 ${step}...`);
    });
    const zipName = discId + '.zip';
    download(zipData, zipName);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    ebootStatusEl.textContent = `Done in ${elapsed}s \u2014 ${formatSize(ebootSize)} saved as ${zipName}`;
    showEbootProgress(1, 'Complete');
    if (done.buildLog) showBuildLogDownload(done.buildLog);
  } catch (err) {
    ebootStatusEl.textContent = `ZIP error: ${err.message}`;
    ebootStatusEl.className = 'status error';
  }
  finishEbootBuild();
}

function finishEbootBuild() {
  ebootWorking = false;
  ebootActiveWorker = null;
  for (const btn of ebootActionsEl.querySelectorAll('button')) btn.disabled = false;
  setEbootInputsDisabled(false);
}
