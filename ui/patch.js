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
  collectDroppedFiles(e.dataTransfer, patchFileInput.accept).then(files => { if (files.length) handlePatchDrop(files); });
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

// ── Jobs ─────────────────────────────────────────────────────────────────────
// Applying is a queue job (queue-tray.js): the staged pairs are captured when
// it is added, so the tab is free for the next set while it waits.

/** "Game (USA).bin" -> "Game (USA) (patched).bin" */
function namePatchedFile(romFile) {
  const baseName = romFile.name.replace(/\.[^.]+$/, '');
  const ext = romFile.name.match(/\.[^.]+$/)?.[0] || '';
  return baseName + ' (patched)' + ext;
}

function buildPatchJob() {
  const pairCount = Math.min(patchRomFiles.length, patchPatchFiles.length);
  const roms = patchRomFiles.slice(0, pairCount);
  const patches = patchPatchFiles.slice(0, pairCount);
  return {
    kind: 'patch',
    key: `patch|${roms.map(fingerprintFile).join('+')}|${patches.map(fingerprintFile).join('+')}`,
    label: pairCount === 1 ? roms[0].name : `${pairCount} discs`,
    detail: pairCount === 1 ? `Patch with ${patches[0].name}` : `Patch \u00b7 ${pairCount} pairs`,
    settings: { roms, patches },
    run: runPatchJob,
  };
}

async function applyPair(rom, patch, onProgress, signal) {
  const done = await runWorker(new Worker('patch-worker.js'), { rom, patch }, {
    signal,
    onProgress: (msg) => onProgress?.(msg.pct, msg.label),
  });
  return { result: new Uint8Array(done.result), format: done.format };
}

async function runPatchJob({ roms, patches }, { onProgress, signal }) {
  // The patch worker reports 0-100; the queue wants 0-1.
  if (roms.length === 1) {
    const { result, format } = await applyPair(roms[0], patches[0], (pct, label) => onProgress(pct / 100, label), signal);
    return { outputs: [{ name: namePatchedFile(roms[0]), data: result }], note: `${format.toUpperCase()} patch applied` };
  }

  // Several pairs run in parallel and are bundled into a ZIP: 0-70% patching, 70-100% packaging.
  const perPairPct = new Array(roms.length).fill(0);
  const results = await Promise.all(roms.map((rom, i) => applyPair(rom, patches[i], (pct) => {
    perPairPct[i] = pct;
    const avg = perPairPct.reduce((a, b) => a + b, 0) / roms.length;
    onProgress(avg / 100 * 0.70, `Patching ${roms.length} discs...`);
  }, signal)));

  const entries = results.map((r, i) => ({ name: namePatchedFile(roms[i]), data: r.result }));
  onProgress(0.70, 'Packaging ZIP...');
  const zipData = await createZipInWorker(entries, (phase, i, total) => {
    const zipPct = measureZipProgress(phase, i, total);
    onProgress(0.70 + zipPct * 0.30, 'Packaging ZIP...');
  }, signal);

  const baseName = roms[0].name.replace(/\.[^.]+$/, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  return { outputs: [{ name: baseName + ' (patched).zip', data: zipData }], note: `${roms.length} patches applied` };
}

patchApplyBtn.addEventListener('click', () => {
  if (Math.min(patchRomFiles.length, patchPatchFiles.length) === 0) return;
  submitJob(buildPatchJob(), patchStatus);
});

registerJobSource('patch', {
  tabId: 'patch',
  tabName: 'Patch',
  restore({ roms, patches }) {
    patchRomFiles = roms.slice();
    patchPatchFiles = patches.slice();
    patchStatus.textContent = '';
    patchStatus.className = 'status';
    updatePatchStaged();
  },
  setEditing(editing) {
    patchApplyBtn.textContent = editing ? 'Save changes' : 'Apply Patch';
  },
  // A drop adds to the staged files, so empty them for the next set.
  clearAfterAdd() {
    patchRomFiles = [];
    patchPatchFiles = [];
    updatePatchStaged();
  },
});
