// ══════════════════════════════════════════════════════════════════════════════
// EBOOT TAB — PS1 disc image → EBOOT.PBP builder
//
// Handles the "EBOOT" tab UI: disc image drop zone, multi-disc management,
// CUE/BIN pairing, game title/disc ID detection, artwork previews and
// compression settings. Build adds a job to the queue (queue-tray.js), which
// shows its progress and saves the ZIP.
//
// Build pipeline (runEbootJob):
//   1. User drops BIN/ISO/CUE files → auto-detect disc ID and title
//   2. Read disc images into ISO_BLOCK_SIZE chunks
//   3. Dispatch chunks to compress-worker.js instances (parallel deflate)
//   4. Send compressed data to eboot-worker.js (assembles PBP)
//   5. Save the result as EBOOT.PBP inside a ZIP
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
const ebootStatusEl = document.getElementById('ebootStatus');
const artIcon0 = document.getElementById('artIcon0');
const artPic0 = document.getElementById('artPic0');
const artPic1 = document.getElementById('artPic1');

let ebootFiles = [];
let pendingCues = [];
let ebootEditing = false; // a queued job is loaded back into the tab to edit

const ebootParentalLevel = document.getElementById('ebootParentalLevel');
const ebootRegion = document.getElementById('ebootRegion');
const ebootFetchArt = document.getElementById('ebootFetchArt');

// Persist fetch-artwork checkbox via localStorage
try { ebootFetchArt.checked = localStorage.getItem('fetchArtwork') === 'true'; } catch {}
ebootFetchArt.addEventListener('change', () => {
  try { localStorage.setItem('fetchArtwork', ebootFetchArt.checked); } catch {}
  scheduleArtworkRegenerate();
});

// The settings a PSP game locks (refusePspGame)
const ebootInputs = [ebootTitle, ebootDiscId, ebootCompression, ebootThreads, ebootParentalLevel, ebootRegion, ebootFetchArt];

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
  currentPic1 = await resizeImageToUint8Array(this.files[0], 480, 272, 'cover');
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
  collectDroppedFiles(e.dataTransfer, ebootFileInput.accept).then(files => { if (files.length) handleEbootDrop(files); });
});
ebootFileInput.addEventListener('change', () => {
  if (ebootFileInput.files.length) handleEbootDrop(ebootFileInput.files);
  ebootFileInput.value = '';
});

async function handleEbootDrop(fileList) {
  const allFiles = Array.from(fileList);
  const cueFiles = allFiles.filter(f => f.name.toLowerCase().endsWith('.cue'));
  const nonCueFiles = allFiles.filter(f => !f.name.toLowerCase().endsWith('.cue'));

  const pspGame = await findPspGame(nonCueFiles);
  if (pspGame) {
    refusePspGame(pspGame.file, pspGame.detected);
    return;
  }

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

// ── PSP games ────────────────────────────────────────────────────────────────
// An EBOOT built here runs in the PSP's PS1 emulator, so a PSP game in one
// cannot start. A PSP game runs from the ISO folder as an ISO or CSO and shows
// the artwork it ships with, so the tab refuses it and says where it goes.

/** The first file that is a PSP UMD image, with what was detected about it, or null. */
async function findPspGame(files) {
  for (const file of files) {
    const detected = await autoDetectDiscId(file);
    if (detected?.platform === 'psp') return { file, detected };
  }
  return null;
}

/** Show the PSP game with every control disabled, and an error saying where it belongs. */
function refusePspGame(file, detected) {
  resetEbootUI();
  ebootFileName.textContent = file.name;
  ebootFileMeta.innerHTML = formatSize(file.size) + ' <span class="format-label format-psp">PSP Game</span>';
  ebootFileInfo.style.display = 'block';
  ebootTitle.value = detected.title || '';
  ebootDiscId.value = detected.discId;
  discIdDetected.textContent = '(auto-detected)';
  showEbootActions();
  ebootActionsEl.querySelector('.btn-eboot').disabled = true;
  setEbootSettingsLocked(true);
  ebootStatusEl.textContent = `${detected.discId} is a PSP game, not a PS1 disc, so it can't become an EBOOT. ` +
    'Put it in the ISO folder on your memory stick as it is, or as a CSO (a compressed copy of the ISO, ' +
    'made in the Convert tab). It shows its own artwork on the PSP.';
  ebootStatusEl.className = 'status error';
}

/** Disable every setting and the artwork slots, but leave the drop zone usable. */
function setEbootSettingsLocked(locked) {
  for (const el of ebootInputs) el.disabled = locked;
  ebootOpts.classList.toggle('locked', locked);
}

function resetEbootUI() {
  setEbootSettingsLocked(false);
  ebootStatusEl.textContent = '';
  ebootStatusEl.className = 'status';
  ebootOpts.style.display = 'none';
  discListEl.innerHTML = '';
  addDiscHint.style.display = 'none';
  ebootFiles = [];
  pendingCues = [];
  icon0IsCustom = pic0IsCustom = pic1IsCustom = false;
  currentIcon0 = currentPic0 = currentPic1 = null;
  // removeAttribute, not src = '': an empty src makes the browser fetch the page itself as the image
  artIcon0.removeAttribute('src');
  artPic0.removeAttribute('src');
  artPic1.removeAttribute('src');
  document.getElementById('artIcon0Reset').style.display = 'none';
  document.getElementById('artPic0Reset').style.display = 'none';
  document.getElementById('artPic1Reset').style.display = 'none';
}

function showEbootActions() {
  ebootActionsEl.innerHTML = '';
  const ebootBtn = document.createElement('button');
  ebootBtn.className = 'btn-eboot';
  ebootBtn.dataset.testid = 'eboot-build-btn';
  ebootBtn.textContent = ebootEditing ? 'Save changes' : 'Build EBOOT.PBP';
  ebootBtn.addEventListener('click', submitEbootJob);
  ebootActionsEl.appendChild(ebootBtn);
  ebootActionsEl.style.display = 'flex';
  ebootOpts.style.display = 'block';
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

/** The build log as a file the queue tray offers beside the job's result. */
function attachBuildLog(log, discId) {
  return {
    label: 'Build log',
    name: `eboot-build-log-${discId}.txt`,
    data: new TextEncoder().encode(formatBuildLog(log)),
  };
}

// ── Parallel compression ─────────────────────────────────────────────────────
// ISO_BLOCK_SIZE (0x9300) is declared in shared.js

async function compressDiscParallel(file, compressionLevel, numThreads, onProgress, signal) {
  const fileSize = file.size;
  const totalBlocks = Math.ceil(fileSize / ISO_BLOCK_SIZE);

  // Each worker reads its own range of blocks from the file, so the disc is never held here.
  onProgress(0, 'Compressing...');
  const doneMessages = await runWorkerPool(() => new Worker('compress-worker.js'), totalBlocks, numThreads, {
    signal,
    message: ({ start, end }) => ({ file, firstBlock: start, endBlock: end, compressionLevel }),
    onProgress: (fraction, workerCount) => {
      onProgress(fraction * 0.95, `Compressing... (${workerCount} workers)`);
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

// ── Jobs ─────────────────────────────────────────────────────────────────────
// A build is a queue job (queue-tray.js). Its settings hold everything the
// form held when it was added — discs, fields and artwork — so the tab is free
// for the next game, and Edit can put them all back.

function buildEbootJob() {
  const title = ebootTitle.value.trim() || 'Unknown';
  const discId = ebootDiscId.value.trim() || 'SLUS00000';
  return {
    kind: 'eboot',
    key: `eboot|${ebootFiles.map(e => fingerprintFile(e.file)).join('+')}`,
    label: title,
    detail: `EBOOT \u00b7 ${discId}${ebootFiles.length > 1 ? ` \u00b7 ${ebootFiles.length} discs` : ''}`,
    settings: {
      discs: ebootFiles.map(e => ({ ...e })),
      title: ebootTitle.value,
      discId: ebootDiscId.value,
      discIdDetected: discIdDetected.textContent,
      compressionLevel: parseInt(ebootCompression.value, 10),
      numThreads: parseInt(ebootThreads.value, 10),
      parentalLevel: parseInt(ebootParentalLevel.value, 10),
      region: parseInt(ebootRegion.value, 16),
      artwork: { icon0: currentIcon0, pic0: currentPic0, pic1: currentPic1, icon0IsCustom, pic0IsCustom, pic1IsCustom },
    },
    run: runEbootJob,
  };
}

function submitEbootJob() {
  if (!ebootFiles.length || pendingCues.length > 0) return;
  submitJob(buildEbootJob(), ebootStatusEl);
}

async function runEbootJob(settings, { onProgress, signal }) {
  const title = settings.title.trim() || 'Unknown';
  const discId = settings.discId.trim() || 'SLUS00000';
  const { discs, compressionLevel, numThreads, parentalLevel, region, artwork } = settings;

  const discIds = discs.map((_, i) => {
    if (i === 0) return discId;
    const base = discId.slice(0, -1);
    const last = parseInt(discId.slice(-1), 10);
    return base + ((last + i) % 10);
  });

  const discInfo = discs.map(entry => {
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

  const files = discs.map(e => e.file);

  // Parallel compression: compress blocks here across workers, then send to eboot-worker for assembly
  let preCompressed = undefined;
  if (numThreads > 1) {
    preCompressed = [];
    for (let d = 0; d < files.length; d++) {
      const discProgress = (pct, label) => {
        const overall = (d + pct) / files.length;
        onProgress(overall * 0.90, `Disc ${d + 1}/${files.length}: ${label}`);
      };
      preCompressed.push(await compressDiscParallel(files[d], compressionLevel, numThreads, discProgress, signal));
    }
  }

  let done;
  try {
    done = await runWorker(new Worker('eboot-worker.js'), {
      files, title, discIds, compressionLevel, parentalLevel, region, discInfo,
      icon0: artwork.icon0 || undefined,
      pic0: artwork.pic0 || undefined,
      pic1: artwork.pic1 || undefined,
      preCompressed,
    }, {
      signal,
      onProgress: (msg) => {
        // Assembly fills 90-96% after parallel compression, else 0-96%; the ZIP takes the rest
        onProgress(preCompressed ? Math.min(0.90 + msg.pct * 0.06, 0.96) : Math.min(msg.pct * 0.96, 0.96), msg.label);
      },
    });
  } catch (err) {
    if (err.workerMessage?.buildLog) err.attachments = [attachBuildLog(err.workerMessage.buildLog, discId)];
    throw err;
  }

  onProgress(0.97, 'Packaging ZIP...');
  const zipData = await createZipInWorker([{ name: discId + '/EBOOT.PBP', data: new Uint8Array(done.result) }], (phase) => {
    const step = phase === 'crc' ? 'Checksumming' : phase === 'alloc' ? 'Allocating' : 'Copying';
    onProgress(0.97, `Packaging ZIP: ${step}...`);
  }, signal);
  return {
    outputs: [{ name: discId + '.zip', data: zipData }],
    attachments: done.buildLog ? [attachBuildLog(done.buildLog, discId)] : [],
  };
}

registerJobSource('eboot', {
  tabId: 'eboot',
  tabName: 'EBOOT',
  restore(settings) {
    resetEbootUI();
    ebootFiles = settings.discs.map(e => ({ ...e }));
    sortEbootFiles();
    renderDiscList();
    addDiscHint.textContent = 'Drop more discs to add them (up to 5)';
    addDiscHint.style.display = 'block';

    const first = ebootFiles[0].file;
    ebootFileName.textContent = first.name;
    ebootFileMeta.innerHTML = formatSize(first.size) + ' <span class="format-label format-ps1">PS1 Disc</span>';
    ebootFileInfo.style.display = 'block';
    showEbootActions();

    ebootTitle.value = settings.title;
    ebootDiscId.value = settings.discId;
    discIdDetected.textContent = settings.discIdDetected;
    ebootCompression.value = settings.compressionLevel;
    updateCompressionLabel();
    ebootThreads.value = settings.numThreads;
    ebootThreadsVal.textContent = settings.numThreads;
    ebootParentalLevel.value = String(settings.parentalLevel);
    ebootRegion.value = settings.region.toString(16);

    const art = settings.artwork;
    currentIcon0 = art.icon0;
    currentPic0 = art.pic0;
    currentPic1 = art.pic1;
    icon0IsCustom = art.icon0IsCustom;
    pic0IsCustom = art.pic0IsCustom;
    pic1IsCustom = art.pic1IsCustom;
    for (const [img, bytes, custom, resetId] of [
      [artIcon0, art.icon0, art.icon0IsCustom, 'artIcon0Reset'],
      [artPic0, art.pic0, art.pic0IsCustom, 'artPic0Reset'],
      [artPic1, art.pic1, art.pic1IsCustom, 'artPic1Reset'],
    ]) {
      if (bytes) img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      else img.removeAttribute('src');
      document.getElementById(resetId).style.display = custom ? 'inline' : 'none';
    }
  },
  setEditing(editing) {
    ebootEditing = editing;
    const btn = ebootActionsEl.querySelector('.btn-eboot');
    if (btn) btn.textContent = editing ? 'Save changes' : 'Build EBOOT.PBP';
  },
  // A drop onto a loaded game adds discs to it, so empty the tab for the next game.
  clearAfterAdd() {
    resetEbootUI();
    ebootFileInfo.style.display = 'none';
    ebootActionsEl.innerHTML = '';
    ebootActionsEl.style.display = 'none';
  },
});
