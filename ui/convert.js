// ══════════════════════════════════════════════════════════════════════════════
// CONVERT TAB — CSO/ZSO/ISO disc image conversion
//
// Handles the "Convert" tab UI: drop zone, format detection and action buttons.
// Each button adds a conversion job to the queue (queue-tray.js), which shows
// its progress and saves the result. Conversion runs in worker.js off-thread.
// ISO→CSO/ZSO compression supports parallel workers for multi-core speedup.
// ══════════════════════════════════════════════════════════════════════════════

const convertDropZone = document.getElementById('convertDropZone');
const convertFileInput = document.getElementById('convertFileInput');
const convertFileInfo = document.getElementById('convertFileInfo');
const convertFileName = document.getElementById('convertFileName');
const convertFileMeta = document.getElementById('convertFileMeta');
const convertActions = document.getElementById('convertActions');
const convertOpts = document.getElementById('convertOpts');
const convertThreads = document.getElementById('convertThreads');
const convertThreadsVal = document.getElementById('convertThreadsVal');
const convertStatus = document.getElementById('convertStatus');

let convertFile = null;
let convertFormat = null;
let convertEditing = false; // a queued job is loaded back into the tab to edit

convertThreadsVal.textContent = convertThreads.value;
convertThreads.addEventListener('input', () => {
  convertThreadsVal.textContent = convertThreads.value;
});

convertDropZone.addEventListener('click', () => convertFileInput.click());
convertDropZone.addEventListener('dragover', e => { e.preventDefault(); convertDropZone.classList.add('dragover'); });
convertDropZone.addEventListener('dragleave', () => convertDropZone.classList.remove('dragover'));
convertDropZone.addEventListener('drop', e => {
  e.preventDefault();
  convertDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleConvertDrop(e.dataTransfer.files);
});
convertFileInput.addEventListener('change', () => {
  if (convertFileInput.files.length) handleConvertDrop(convertFileInput.files);
  convertFileInput.value = '';
});

async function handleConvertDrop(fileList) {
  const file = fileList[0];
  convertFile = file;
  const format = await detectConvertFormat(file);
  convertFormat = format;

  // Reset
  convertStatus.textContent = '';
  convertStatus.className = 'status';

  // Show file info
  convertFileName.textContent = file.name;
  let metaHTML = formatSize(file.size);
  if (format === 'CSO' || format === 'ZSO') {
    const headerSlice = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const header = parseCsoHeader(headerSlice);
    metaHTML += ` &rarr; ${formatSize(header.uncompressedSize)} uncompressed`;
  }
  const fmtClass = 'format-' + format.toLowerCase();
  metaHTML += ` <span class="format-label ${fmtClass}">${format}</span>`;
  convertFileMeta.innerHTML = metaHTML;
  convertFileInfo.style.display = 'block';

  // Show Workers slider only for ISO sources (compression is CPU-bound)
  convertOpts.style.display = format === 'ISO' ? 'block' : 'none';

  renderConvertActions();
}

/** One button per format the loaded file can become; while editing a queued job they save the change. */
function renderConvertActions() {
  convertActions.innerHTML = '';
  if (!convertFile) return;
  const targets = ['ISO', 'CSO', 'ZSO'].filter(f => f !== convertFormat);
  for (const t of targets) {
    const btn = document.createElement('button');
    btn.className = 'btn-' + t.toLowerCase();
    btn.dataset.testid = `convert-to-${t.toLowerCase()}`;
    btn.textContent = convertEditing ? `Save changes: to ${t}` : `Convert to ${t}`;
    btn.addEventListener('click', () => {
      const job = buildConvertJob(convertFile, convertFormat, t, parseInt(convertThreads.value, 10));
      submitJob(job, convertStatus);
    });
    convertActions.appendChild(btn);
  }
  convertActions.style.display = 'flex';
}

// ── Parallel ISO→CSO/ZSO compression ─────────────────────────────────────────

async function compressISOParallel(file, targetFormat, numThreads, onProgress, signal) {
  const BLOCK_SIZE = 2048;
  const isoSize = file.size;
  const totalBlocks = Math.ceil(isoSize / BLOCK_SIZE);

  // Each worker reads its own range of blocks from the file, so the ISO is never held here.
  onProgress(0, 'Compressing...');
  const doneMessages = await runWorkerPool(() => new Worker('cso-compress-worker.js'), totalBlocks, numThreads, {
    signal,
    message: ({ start, end }) => ({ file, firstBlock: start, endBlock: end, targetFormat }),
    onProgress: (fraction, workerCount) => {
      onProgress(fraction * 0.9, `Compressing... (${workerCount} workers)`);
    },
  });
  const rangeResults = doneMessages.map(done => ({
    parts: done.parts.map(p => new Uint8Array(p.buffer || p)),
    uncompressedFlags: done.uncompressedFlags,
  }));

  onProgress(0.9, 'Building output file...');

  // Stitch: header + index + compressed parts
  const HEADER_SIZE = 24;
  const indexShift = 0;
  const indexCount = totalBlocks + 1;
  const magic = targetFormat === 'CSO' ? 'CISO' : 'ZISO';

  // Calculate total size
  let dataSize = 0;
  for (const wr of rangeResults) {
    for (const part of wr.parts) dataSize += part.length;
  }
  const headerAndIndexSize = HEADER_SIZE + indexCount * 4;
  const totalSize = headerAndIndexSize + dataSize;

  const result = new Uint8Array(totalSize);
  const dv = new DataView(result.buffer);

  // Write header
  for (let i = 0; i < 4; i++) result[i] = magic.charCodeAt(i);
  dv.setUint32(4, 0x18, true);
  dv.setBigUint64(8, BigInt(isoSize), true);
  dv.setUint32(16, BLOCK_SIZE, true);
  result[20] = 1; // version
  result[21] = indexShift;

  // Write index + data
  let currentOffset = headerAndIndexSize;
  let blockIdx = 0;
  for (const wr of rangeResults) {
    for (let i = 0; i < wr.parts.length; i++) {
      let indexVal = currentOffset >>> indexShift;
      if (wr.uncompressedFlags[i]) indexVal |= 0x80000000;
      dv.setUint32(HEADER_SIZE + blockIdx * 4, indexVal, true);
      result.set(wr.parts[i], currentOffset);
      currentOffset += wr.parts[i].length;
      blockIdx++;
    }
  }
  // Final index entry (sentinel)
  dv.setUint32(HEADER_SIZE + totalBlocks * 4, currentOffset >>> indexShift, true);

  onProgress(1, 'Complete');
  return result;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────
// A conversion is a queue job (queue-tray.js): its settings are captured
// when it is added, so the tab is free for the next file while it waits.

function buildConvertJob(file, sourceFormat, targetFormat, numThreads) {
  return {
    kind: 'convert',
    key: `convert|${fingerprintFile(file)}|${targetFormat}`,
    label: file.name,
    detail: `Convert to ${targetFormat}`,
    settings: { file, sourceFormat, targetFormat, numThreads },
    run: runConvertJob,
  };
}

async function runConvertJob({ file, sourceFormat, targetFormat, numThreads }, { onProgress, signal }) {
  const name = `${file.name.replace(/\.[^.]+$/, '')}.${targetFormat.toLowerCase()}`;
  // ISO to CSO/ZSO can spread compression across workers; the rest is one worker's job.
  if (sourceFormat === 'ISO' && numThreads > 1) {
    return [{ name, data: await compressISOParallel(file, targetFormat, numThreads, onProgress, signal) }];
  }
  const done = await runWorker(new Worker('worker.js'), { file, sourceFormat, targetFormat }, {
    signal,
    onProgress: (msg) => onProgress(msg.pct, msg.label),
  });
  return [{ name, data: done.result }];
}

registerJobSource('convert', {
  tabId: 'convert',
  tabName: 'Convert',
  async restore({ file, numThreads }) {
    await handleConvertDrop([file]);
    convertThreads.value = numThreads;
    convertThreadsVal.textContent = numThreads;
  },
  setEditing(editing) {
    convertEditing = editing;
    renderConvertActions();
  },
});
