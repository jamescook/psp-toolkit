// ══════════════════════════════════════════════════════════════════════════════
// SAVE MANAGER TAB — list PS1 saves on a GME/MCR memory card, extract to VMP
//
// Listing (parsing the card's directory) runs on the main thread -- it's a
// cheap synchronous read, matching this project's "no worker for read-only
// inspection" convention (see diagnose.js). It duplicates save/gme.js's
// stripGmeHeader() and save/mcr.js's parseMcr() locally rather than importing
// them, because ui/*.js files are plain concatenated scripts, not ES modules
// (see ui/shared.js's autoDetectDiscId for the same tradeoff, spelled out
// there). Extraction (isolating a save + signing the VMP) runs in
// save-worker.js, one worker per selected slot, following the same
// off-main-thread pattern as convert/eboot/patch even though a single 128KB
// card is fast enough not to strictly need it.
// ══════════════════════════════════════════════════════════════════════════════

const saveDropZone = document.getElementById('saveDropZone');
const saveFileInput = document.getElementById('saveFileInput');
const saveFileInfo = document.getElementById('saveFileInfo');
const saveFileName = document.getElementById('saveFileName');
const saveFileMeta = document.getElementById('saveFileMeta');
const saveSlotControls = document.getElementById('saveSlotControls');
const saveSelectAllBtn = document.getElementById('saveSelectAllBtn');
const saveSlotCount = document.getElementById('saveSlotCount');
const saveSlotList = document.getElementById('saveSlotList');
const saveExtractBtn = document.getElementById('saveExtractBtn');
const saveProgressArea = document.getElementById('saveProgressArea');
const saveProgressFill = document.getElementById('saveProgressFill');
const saveProgressLabel = document.getElementById('saveProgressLabel');
const saveProgressPct = document.getElementById('saveProgressPct');
const saveStatus = document.getElementById('saveStatus');
const saveInfoBox = document.getElementById('saveInfoBox');

let currentMcr = null;   // Uint8Array — the current card, GME header already stripped
let currentSlots = [];   // parsed 'initial' slots (one row per real save)
let currentSourceName = '';

// ── Duplicated read-only logic (see file header for why) ────────────────────

const SAVE_MCR_SIZE = 131072;
const SAVE_HEADER_SIZE = 128;
const SAVE_MAX_SLOTS = 15;
const SAVE_GME_HEADER_SIZE = 3904;
const SAVE_GME_MAGIC = '123-456-STD';

const SAVE_BLOCK_TYPES = {
  0xa0: 'formatted',
  0x51: 'initial',
  0x52: 'middle-link',
  0x53: 'end-link',
  0xa1: 'deleted-initial',
  0xa2: 'deleted-middle-link',
  0xa3: 'deleted-end-link',
};

function saveAsciiSlice(buf, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = buf[start + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** Strip a GME (DexDrive) container down to its raw 128KB memory card, or
 *  return the input as-is if it's already a bare 128KB card. */
function stripToRawMcr(data) {
  if (data.length === SAVE_MCR_SIZE) return data;

  const magic = String.fromCharCode(...data.subarray(0, SAVE_GME_MAGIC.length));
  if (data.length === SAVE_GME_HEADER_SIZE + SAVE_MCR_SIZE && magic === SAVE_GME_MAGIC) {
    return data.subarray(SAVE_GME_HEADER_SIZE);
  }
  throw new Error(`Not a .gme or raw memory card file (got ${data.length} bytes)`);
}

/** Parse the directory of a raw 128KB card into its 15 slots (mirrors save/mcr.js). */
function parseRawMcr(data) {
  const slots = [];
  for (let i = 0; i < SAVE_MAX_SLOTS; i++) {
    const off = SAVE_HEADER_SIZE * (i + 1);
    const header = data.subarray(off, off + SAVE_HEADER_SIZE);
    slots.push({
      index: i,
      type: SAVE_BLOCK_TYPES[header[0]] || 'corrupted',
      size: header[4] | (header[5] << 8) | (header[6] << 16),
      region: saveAsciiSlice(header, 0x0a, 2),
      productCode: saveAsciiSlice(header, 0x0c, 10),
      identifier: saveAsciiSlice(header, 0x16, 8),
      name: saveAsciiSlice(header, 0x0a, 20),
    });
  }
  return slots;
}

/** Folder name a real POPS build would use under PSP/SAVEDATA/ for this save. */
function gameFolderName(slot) {
  const code = slot.productCode.replace(/[^A-Za-z0-9]/g, '');
  return code || 'SAVE';
}

// ── Drop zone ────────────────────────────────────────────────────────────────

saveDropZone.addEventListener('click', () => saveFileInput.click());
saveDropZone.addEventListener('dragover', e => { e.preventDefault(); saveDropZone.classList.add('dragover'); });
saveDropZone.addEventListener('dragleave', () => saveDropZone.classList.remove('dragover'));
saveDropZone.addEventListener('drop', e => {
  e.preventDefault();
  saveDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleSaveDrop(e.dataTransfer.files[0]);
});
saveFileInput.addEventListener('change', () => {
  if (saveFileInput.files.length) handleSaveDrop(saveFileInput.files[0]);
  saveFileInput.value = '';
});

async function handleSaveDrop(file) {
  saveStatus.textContent = '';
  saveStatus.className = 'status';
  saveSlotList.innerHTML = '';
  saveExtractBtn.disabled = true;
  hideSaveInfoBox();
  currentMcr = null;
  currentSlots = [];

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const mcr = stripToRawMcr(data);
    const slots = parseRawMcr(mcr).filter(s => s.type === 'initial');

    currentMcr = mcr;
    currentSlots = slots;
    currentSourceName = file.name.replace(/\.[^.]+$/, '');

    const isGme = data.length !== SAVE_MCR_SIZE;
    saveFileName.textContent = file.name;
    saveFileMeta.innerHTML = `${formatSize(file.size)} <span class="format-label ${isGme ? 'format-gme' : 'format-mcr'}">${isGme ? 'GME' : 'MCR'}</span>`;
    saveFileInfo.style.display = 'block';

    renderSlotList();

    if (slots.length === 0) {
      saveStatus.textContent = 'No saves found on this card.';
    } else {
      showSaveInfoBox('Where extracted saves go on your PSP or PS Vita', [
        `A single save downloads as one <code>.VMP</code> file — copy it to <code>PSP/SAVEDATA/&lt;game&gt;/SCEVMC0.VMP</code> on the memory stick/card, via USB or FTP.`,
        `Multiple saves download as a ZIP — extract it directly onto the root of the memory stick/card, it already contains the right <code>PSP/SAVEDATA/&lt;game&gt;/</code> folder layout.`,
        `If a folder already has a save for that game, back it up first — this will overwrite it.`,
      ]);
    }
  } catch (err) {
    saveStatus.textContent = `Error: ${err.message}`;
    saveStatus.className = 'status error';
  }
}

// ── Slot list ────────────────────────────────────────────────────────────────

function renderSlotList() {
  saveSlotList.innerHTML = '';
  for (const slot of currentSlots) {
    const item = document.createElement('label');
    item.className = 'save-slot-item';
    item.dataset.testid = 'save-slot-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.slotIndex = slot.index;
    checkbox.addEventListener('change', updateSelectionState);

    const name = document.createElement('span');
    name.className = 'save-slot-name';
    name.textContent = slot.name || slot.productCode || `Slot ${slot.index + 1}`;

    const code = document.createElement('span');
    code.className = 'save-slot-code';
    code.textContent = slot.productCode;

    const size = document.createElement('span');
    size.className = 'save-slot-size';
    size.textContent = formatSize(slot.size);

    item.append(checkbox, name, code, size);
    saveSlotList.appendChild(item);
  }
  saveSlotControls.style.display = currentSlots.length > 0 ? 'flex' : 'none';
  updateSelectionState();
}

function allCheckboxes() {
  return [...saveSlotList.querySelectorAll('input[type="checkbox"]')];
}

function selectedSlots() {
  return allCheckboxes().filter(cb => cb.checked)
    .map(cb => currentSlots.find(s => s.index === Number(cb.dataset.slotIndex)));
}

function updateSelectionState() {
  const total = currentSlots.length;
  const n = selectedSlots().length;

  saveExtractBtn.disabled = n === 0;
  saveExtractBtn.textContent = n > 1 ? `Extract ${n} Saves (ZIP)` : 'Extract to VMP';

  saveSlotCount.textContent = total > 0 ? `${n} of ${total} selected` : '';
  saveSelectAllBtn.textContent = n === total && total > 0 ? 'Deselect All' : 'Select All';
}

saveSelectAllBtn.addEventListener('click', () => {
  const shouldSelectAll = selectedSlots().length !== currentSlots.length;
  for (const cb of allCheckboxes()) cb.checked = shouldSelectAll;
  updateSelectionState();
});

// ── Progress helpers ─────────────────────────────────────────────────────────

function showSaveProgress(pct, label) {
  saveProgressArea.style.display = 'block';
  saveProgressFill.style.width = pct + '%';
  saveProgressPct.textContent = pct + '%';
  saveProgressLabel.textContent = label;
}

function hideSaveProgress() {
  saveProgressArea.style.display = 'none';
}

function showSaveInfoBox(title, items) {
  saveInfoBox.innerHTML = `<span class="save-info-title">${title}</span><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  saveInfoBox.style.display = 'block';
}

function hideSaveInfoBox() {
  saveInfoBox.style.display = 'none';
}

// ── Extraction ───────────────────────────────────────────────────────────────

function extractSlotToVmp(mcr, slotIndex, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('save-worker.js');

    worker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.pct, msg.label);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(new Uint8Array(msg.result));
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = function(err) {
      worker.terminate();
      reject(new Error(err.message || String(err)));
    };

    worker.postMessage({ mcr: mcr.buffer.slice(mcr.byteOffset, mcr.byteOffset + mcr.byteLength), slotIndex });
  });
}

saveExtractBtn.addEventListener('click', async () => {
  const slots = selectedSlots();
  if (slots.length === 0) return;

  saveExtractBtn.disabled = true;
  saveStatus.textContent = '';
  saveStatus.className = 'status';
  hideSaveInfoBox();
  showSaveProgress(0, 'Starting...');

  const folderCounts = new Map();
  function nextVmpName(slot) {
    const folder = gameFolderName(slot);
    const n = folderCounts.get(folder) || 0;
    folderCounts.set(folder, n + 1);
    return { folder, filename: `SCEVMC${n}.VMP` };
  }

  if (slots.length === 1) {
    try {
      const vmp = await extractSlotToVmp(currentMcr, slots[0].index, showSaveProgress);
      const { folder, filename } = nextVmpName(slots[0]);
      const outName = `${folder}-${filename}`;
      download(vmp, outName);
      hideSaveProgress();
      saveStatus.textContent = `Done — saved as ${outName} (rename to ${filename} for PSP/SAVEDATA/${folder}/)`;
    } catch (err) {
      saveStatus.textContent = `Error: ${err.message}`;
      saveStatus.className = 'status error';
      hideSaveProgress();
    }
    updateSelectionState();
    return;
  }

  const perSlotPct = new Array(slots.length).fill(0);
  function updateOverall() {
    const avg = perSlotPct.reduce((a, b) => a + b, 0) / slots.length;
    showSaveProgress(Math.round(avg * 0.8), `Extracting ${slots.length} saves...`);
  }

  try {
    const results = await Promise.all(slots.map((slot, i) =>
      extractSlotToVmp(currentMcr, slot.index, pct => { perSlotPct[i] = pct; updateOverall(); })
    ));

    const entries = slots.map((slot, i) => {
      const { folder, filename } = nextVmpName(slot);
      return { name: `PSP/SAVEDATA/${folder}/${filename}`, data: results[i] };
    });

    showSaveProgress(80, 'Packaging ZIP...');
    const zipData = await createZipInWorker(entries, (phase, i, total) => {
      const zipPct = phase === 'crc' ? i / total * 0.6 : phase === 'alloc' ? 0.6 : 0.6 + (i + 1) / total * 0.4;
      showSaveProgress(80 + Math.round(zipPct * 20), `Packaging ZIP...`);
    });

    const zipName = `${currentSourceName} (saves).zip`;
    download(zipData, zipName);
    hideSaveProgress();
    saveStatus.textContent = `Done — ${slots.length} saves extracted. Saved as ${zipName}`;
  } catch (err) {
    saveStatus.textContent = `Error: ${err.message}`;
    saveStatus.className = 'status error';
    hideSaveProgress();
  }

  updateSelectionState();
});
