// ══════════════════════════════════════════════════════════════════════════════
// PATCH TAB — Apply IPS/PPF/BPS/xdelta patches to ROM/disc images
//
// Supports batch patching: drop multiple ROMs and patches, reorder via
// drag/drop, and apply all pairs sequentially. Files are paired positionally
// (first ROM ↔ first patch, etc). Single ROM + single patch works as before.
// ══════════════════════════════════════════════════════════════════════════════

const patchDropZone = document.getElementById('patchDropZone');
const patchFileInput = document.getElementById('patchFileInput');
const patchRomSlot = document.getElementById('patchRomSlot');
const patchRomName = document.getElementById('patchRomName');
const patchRomList = document.getElementById('patchRomList');
const patchPatchSlot = document.getElementById('patchPatchSlot');
const patchPatchName = document.getElementById('patchPatchName');
const patchPatchList = document.getElementById('patchPatchList');
const patchApplyBtn = document.getElementById('patchApplyBtn');
const patchClearBtn = document.getElementById('patchClearBtn');
const patchProgressArea = document.getElementById('patchProgressArea');
const patchProgressFill = document.getElementById('patchProgressFill');
const patchProgressLabel = document.getElementById('patchProgressLabel');
const patchProgressPct = document.getElementById('patchProgressPct');
const patchStatus = document.getElementById('patchStatus');

let patchRomFiles = [];
let patchPatchFiles = [];

const PATCH_EXTS = ['.ips', '.ppf', '.bps', '.xdelta', '.vcdiff'];
const ROM_EXTS = ['.bin', '.iso', '.img'];

function classifyFile(file) {
  const ext = file.name.replace(/^.*(\.[^.]+)$/, '$1').toLowerCase();
  if (PATCH_EXTS.includes(ext)) return 'patch';
  if (ROM_EXTS.includes(ext)) return 'rom';
  return null;
}

// ── Drop zone ────────────────────────────────────────────────────────────────

patchDropZone.addEventListener('click', () => patchFileInput.click());
patchDropZone.addEventListener('dragover', e => { e.preventDefault(); patchDropZone.classList.add('dragover'); });
patchDropZone.addEventListener('dragleave', () => patchDropZone.classList.remove('dragover'));
patchDropZone.addEventListener('drop', e => {
  e.preventDefault();
  patchDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handlePatchDrop(e.dataTransfer.files);
});
patchFileInput.addEventListener('change', () => {
  if (patchFileInput.files.length) handlePatchDrop(patchFileInput.files);
  patchFileInput.value = '';
});

function handlePatchDrop(fileList) {
  patchStatus.textContent = '';
  patchStatus.className = 'status';

  for (const file of fileList) {
    const type = classifyFile(file);
    if (type === 'rom') {
      patchRomFiles.push(file);
    } else if (type === 'patch') {
      patchPatchFiles.push(file);
    } else {
      const ext = file.name.replace(/^.*(\.[^.]+)$/, '$1').toLowerCase();
      if (ext === '.cue') {
        patchStatus.textContent = 'CUE files are not supported — drop the .bin file directly.';
      } else {
        patchStatus.textContent = `Unrecognized file type: ${file.name}`;
      }
      patchStatus.className = 'status error';
      return;
    }
  }

  updatePatchStaged();
}

// ── Clear button ─────────────────────────────────────────────────────────────

patchClearBtn.addEventListener('click', () => {
  patchRomFiles = [];
  patchPatchFiles = [];
  patchStatus.textContent = '';
  patchStatus.className = 'status';
  updatePatchStaged();
});

// ── Drag/drop reordering within file lists ───────────────────────────────────

function setupDragReorder(listEl, getFiles, setFiles) {
  let dragIdx = null;

  listEl.addEventListener('dragstart', e => {
    const item = e.target.closest('.patch-file-item');
    if (!item) return;
    dragIdx = parseInt(item.dataset.index, 10);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  listEl.addEventListener('dragend', e => {
    const item = e.target.closest('.patch-file-item');
    if (item) item.classList.remove('dragging');
    listEl.querySelectorAll('.patch-file-item').forEach(el => el.classList.remove('drag-over'));
    dragIdx = null;
  });

  listEl.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.patch-file-item');
    if (item) {
      listEl.querySelectorAll('.patch-file-item').forEach(el => el.classList.remove('drag-over'));
      item.classList.add('drag-over');
    }
  });

  listEl.addEventListener('dragleave', e => {
    const item = e.target.closest('.patch-file-item');
    if (item) item.classList.remove('drag-over');
  });

  listEl.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    const item = e.target.closest('.patch-file-item');
    if (!item || dragIdx === null) return;
    const dropIdx = parseInt(item.dataset.index, 10);
    if (dragIdx === dropIdx) return;
    const files = getFiles();
    const [moved] = files.splice(dragIdx, 1);
    files.splice(dropIdx, 0, moved);
    setFiles(files);
    updatePatchStaged();
  });
}

setupDragReorder(
  patchRomList,
  () => patchRomFiles,
  f => { patchRomFiles = f; }
);
setupDragReorder(
  patchPatchList,
  () => patchPatchFiles,
  f => { patchPatchFiles = f; }
);

// ── Staged files display ─────────────────────────────────────────────────────

function renderFileList(listEl, files, removeCallback) {
  listEl.innerHTML = '';
  files.forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'patch-file-item';
    item.draggable = files.length > 1;
    item.dataset.index = idx;
    item.dataset.testid = 'patch-file-item';

    const num = document.createElement('span');
    num.className = 'patch-file-num';
    num.textContent = idx + 1;

    const name = document.createElement('span');
    name.className = 'patch-file-name';
    name.textContent = file.name;

    const size = document.createElement('span');
    size.className = 'patch-file-size';
    size.textContent = formatSize(file.size);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'patch-file-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      removeCallback(idx);
    });

    item.append(num, name, size, removeBtn);
    listEl.appendChild(item);
  });
}

function updatePatchStaged() {
  const hasRoms = patchRomFiles.length > 0;
  const hasPatches = patchPatchFiles.length > 0;

  // ROM slot
  if (hasRoms) {
    patchRomName.textContent = patchRomFiles.length === 1
      ? `${patchRomFiles[0].name} (${formatSize(patchRomFiles[0].size)})`
      : `${patchRomFiles.length} files`;
    patchRomSlot.classList.add('filled');
  } else {
    patchRomName.textContent = 'None';
    patchRomSlot.classList.remove('filled');
  }

  // Patch slot
  if (hasPatches) {
    patchPatchName.textContent = patchPatchFiles.length === 1
      ? `${patchPatchFiles[0].name} (${formatSize(patchPatchFiles[0].size)})`
      : `${patchPatchFiles.length} files`;
    patchPatchSlot.classList.add('filled');
  } else {
    patchPatchName.textContent = 'None';
    patchPatchSlot.classList.remove('filled');
  }

  // Render file lists (only show when >1 file in either category)
  const showLists = patchRomFiles.length > 1 || patchPatchFiles.length > 1;
  renderFileList(patchRomList, showLists ? patchRomFiles : [], idx => {
    patchRomFiles.splice(idx, 1);
    updatePatchStaged();
  });
  renderFileList(patchPatchList, showLists ? patchPatchFiles : [], idx => {
    patchPatchFiles.splice(idx, 1);
    updatePatchStaged();
  });

  // Clear button
  patchClearBtn.style.display = (hasRoms || hasPatches) ? '' : 'none';

  // Button state
  const pairCount = Math.min(patchRomFiles.length, patchPatchFiles.length);
  if (!hasRoms && !hasPatches) {
    patchApplyBtn.disabled = true;
    patchApplyBtn.title = 'Drop a disc image and a patch file';
  } else if (!hasRoms) {
    patchApplyBtn.disabled = true;
    patchApplyBtn.title = 'Disc image needed — drop a .bin or .iso file';
  } else if (!hasPatches) {
    patchApplyBtn.disabled = true;
    patchApplyBtn.title = 'Patch file needed — drop a .ips, .ppf, .bps, or .xdelta file';
  } else {
    patchApplyBtn.disabled = false;
    patchApplyBtn.title = pairCount > 1 ? `Apply ${pairCount} patches` : '';
  }

  // Warn about mismatched counts
  if (hasRoms && hasPatches && patchRomFiles.length !== patchPatchFiles.length) {
    patchStatus.textContent = `${patchRomFiles.length} ROM(s) and ${patchPatchFiles.length} patch(es) — only ${pairCount} pair(s) will be applied.`;
    patchStatus.className = 'status';
  }
}

// ── Progress helpers ─────────────────────────────────────────────────────────

function showPatchProgress(pct, label) {
  patchProgressArea.style.display = 'block';
  patchProgressFill.style.width = pct + '%';
  patchProgressPct.textContent = pct + '%';
  patchProgressLabel.textContent = label;
}

function hidePatchProgress() {
  patchProgressArea.style.display = 'none';
}

// ── Apply (parallel batch) ───────────────────────────────────────────────────

async function applyPair(rom, patch, onProgress) {
  const done = await runWorker(new Worker('patch-worker.js'), { rom, patch }, {
    onProgress: (msg) => onProgress?.(msg.pct, msg.label),
  });
  return { result: new Uint8Array(done.result), format: done.format };
}

patchApplyBtn.addEventListener('click', async () => {
  const pairCount = Math.min(patchRomFiles.length, patchPatchFiles.length);
  if (pairCount === 0) return;

  patchApplyBtn.disabled = true;
  patchClearBtn.style.display = 'none';
  patchStatus.textContent = '';
  patchStatus.className = 'status';
  showPatchProgress(0, 'Starting...');

  // Build output filename helper
  function patchedName(romFile) {
    const baseName = romFile.name.replace(/\.[^.]+$/, '');
    const ext = romFile.name.match(/\.[^.]+$/)?.[0] || '';
    return baseName + ' (patched)' + ext;
  }

  if (pairCount === 1) {
    // Single pair — direct download, no ZIP
    try {
      const { result, format } = await applyPair(patchRomFiles[0], patchPatchFiles[0], (pct, label) => {
        showPatchProgress(pct, label);
      });
      const filename = patchedName(patchRomFiles[0]);
      download(result, filename);
      hidePatchProgress();
      patchStatus.textContent = `Done — ${format.toUpperCase()} patch applied. Saved as ${filename}`;
    } catch (err) {
      patchStatus.textContent = `Error: ${err.message}`;
      patchStatus.className = 'status error';
      hidePatchProgress();
    }
    patchApplyBtn.disabled = false;
    patchClearBtn.style.display = '';
    return;
  }

  // Multiple pairs — run workers in parallel, bundle into ZIP
  // Reserve 0–70% for patching, 70–100% for ZIP packaging (CRC + copy is slow for large files)
  const perPairPct = new Array(pairCount).fill(0);
  const perPairLabel = new Array(pairCount).fill('Starting...');

  function updateOverallProgress() {
    const avg = perPairPct.reduce((a, b) => a + b, 0) / pairCount;
    const scaled = Math.round(avg * 0.70);
    const parts = perPairPct.map((p, i) => {
      const name = patchRomFiles[i].name;
      if (p >= 100) return `${name} ✓`;
      return `${name} ${p}%`;
    });
    showPatchProgress(scaled, parts.join(' · '));
  }

  const promises = [];
  for (let i = 0; i < pairCount; i++) {
    const rom = patchRomFiles[i];
    const patch = patchPatchFiles[i];
    const p = applyPair(rom, patch, (pct, label) => {
      perPairPct[i] = pct;
      perPairLabel[i] = label;
      updateOverallProgress();
    });
    promises.push(p);
  }

  try {
    const results = await Promise.all(promises);

    // Build ZIP entries
    const entries = results.map((r, i) => ({
      name: patchedName(patchRomFiles[i]),
      data: r.result,
    }));

    showPatchProgress(70, 'Packaging ZIP...');
    const zipData = await createZipInWorker(entries, (phase, i, total) => {
      // CRC is ~60% of ZIP work, copy is ~40%
      let zipPct;
      if (phase === 'crc') zipPct = i / total * 0.6;
      else if (phase === 'alloc') zipPct = 0.6;
      else zipPct = 0.6 + (i + 1) / total * 0.4;
      const scaled = 70 + Math.round(zipPct * 30);
      const step = phase === 'crc' ? 'Checksumming' : phase === 'alloc' ? 'Allocating' : 'Copying';
      showPatchProgress(scaled, `Packaging ZIP \u2014 ${step} file ${i + 1}/${total}...`);
    });

    // Dereference individual results
    for (const r of results) r.result = null;

    const baseName = patchRomFiles[0].name.replace(/\.[^.]+$/, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
    const zipName = baseName + ' (patched).zip';
    download(zipData, zipName);

    hidePatchProgress();
    patchStatus.textContent = `Done — ${pairCount} patches applied. Saved as ${zipName}`;
  } catch (err) {
    patchStatus.textContent = `Error: ${err.message}`;
    patchStatus.className = 'status error';
    hidePatchProgress();
  }

  patchApplyBtn.disabled = false;
  patchClearBtn.style.display = '';
});
