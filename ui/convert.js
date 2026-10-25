// ══════════════════════════════════════════════════════════════════════════════
// CONVERT TAB — CSO/ZSO/ISO disc image conversion
//
// Handles the "Convert" tab UI: drop zone, format detection, action buttons,
// progress display, and download. Conversion runs in worker.js off-thread.
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
const convertProgressArea = document.getElementById('convertProgressArea');
const convertProgressFill = document.getElementById('convertProgressFill');
const convertProgressLabel = document.getElementById('convertProgressLabel');
const convertProgressPct = document.getElementById('convertProgressPct');
const convertStatus = document.getElementById('convertStatus');

let convertFile = null;
let convertFormat = null;
let convertWorking = false;
let convertActiveWorkers = [];

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
  if (convertWorking) return;
  const file = fileList[0];
  convertFile = file;
  const format = await detectConvertFormat(file);
  convertFormat = format;

  // Reset
  convertStatus.textContent = '';
  convertStatus.className = 'status';
  convertProgressArea.style.display = 'none';

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

  // Build action buttons
  convertActions.innerHTML = '';
  const targets = ['ISO', 'CSO', 'ZSO'].filter(f => f !== format);
  for (const t of targets) {
    const btn = document.createElement('button');
    btn.className = 'btn-' + t.toLowerCase();
    btn.dataset.testid = `convert-to-${t.toLowerCase()}`;
    btn.textContent = `Convert to ${t}`;
    btn.addEventListener('click', () => startCsoConversion(t));
    convertActions.appendChild(btn);
  }
  convertActions.style.display = 'flex';
}

function showConvertProgress(pct, label) {
  const p = Math.round(pct * 100);
  convertProgressFill.style.width = p + '%';
  convertProgressPct.textContent = p + '%';
  convertProgressLabel.textContent = label;
}

// ── Parallel ISO→CSO/ZSO compression ─────────────────────────────────────────

async function compressISOParallel(file, targetFormat, numThreads, onProgress) {
  const BLOCK_SIZE = 2048;
  const isoSize = file.size;
  const totalBlocks = Math.ceil(isoSize / BLOCK_SIZE);

  // Read all blocks from file
  onProgress(0, 'Reading ISO...');
  const allBlocks = [];
  for (let i = 0; i < totalBlocks; i++) {
    const start = i * BLOCK_SIZE;
    const end = Math.min(start + BLOCK_SIZE, isoSize);
    allBlocks.push(await file.slice(start, end).arrayBuffer());
    if (i % 512 === 0) {
      onProgress(i / totalBlocks * 0.2, `Reading block ${i}/${totalBlocks}`);
    }
  }

  onProgress(0.2, 'Compressing...');

  // Split blocks into ranges for workers
  const blocksPerWorker = Math.ceil(totalBlocks / numThreads);
  const ranges = [];
  for (let i = 0; i < numThreads; i++) {
    const start = i * blocksPerWorker;
    const end = Math.min(start + blocksPerWorker, totalBlocks);
    if (start < totalBlocks) {
      ranges.push(allBlocks.slice(start, end));
    }
  }

  // Spawn workers and distribute work
  const workerProgress = new Array(ranges.length).fill(0);

  const rangeResults = await Promise.all(ranges.map(async (blocks, r) => {
    const worker = new Worker('cso-compress-worker.js');
    convertActiveWorkers.push(worker);
    const done = await runWorker(worker, { blocks, targetFormat }, {
      transfer: blocks.slice(),
      onProgress: (msg) => {
        workerProgress[r] = msg.blockIndex / msg.totalBlocks;
        const avgProgress = workerProgress.reduce((a, b) => a + b, 0) / ranges.length;
        onProgress(0.2 + avgProgress * 0.7, `Compressing... (${ranges.length} workers)`);
      },
    });
    return {
      parts: done.parts.map(p => new Uint8Array(p.buffer || p)),
      uncompressedFlags: done.uncompressedFlags,
    };
  }));

  convertActiveWorkers = [];
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

// ── Conversion entry point ────────────────────────────────────────────────────

function startCsoConversion(targetFormat) {
  if (convertWorking) return;
  convertWorking = true;
  for (const btn of convertActions.querySelectorAll('button')) btn.disabled = true;
  convertThreads.disabled = true;
  convertProgressArea.style.display = 'block';
  showConvertProgress(0, 'Starting...');
  convertStatus.textContent = '';
  convertStatus.className = 'status';

  const baseName = convertFile.name.replace(/\.[^.]+$/, '');
  const ext = targetFormat.toLowerCase();
  const t0 = performance.now();
  const numThreads = parseInt(convertThreads.value, 10);

  // Use parallel path for ISO→CSO/ZSO with multiple threads
  if (convertFormat === 'ISO' && numThreads > 1) {
    startParallelConversion(targetFormat, baseName, ext, t0, numThreads);
    return;
  }

  // Single-worker path (decompression, transcompression, or single-thread compression)
  startSingleConversion(targetFormat, baseName, ext, t0);
}

async function startSingleConversion(targetFormat, baseName, ext, t0) {
  try {
    const done = await runWorker(new Worker('worker.js'), { file: convertFile, sourceFormat: convertFormat, targetFormat }, {
      onProgress: (msg) => showConvertProgress(msg.pct, msg.label),
    });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const filename = `${baseName}.${ext}`;
    download(done.result, filename);
    convertStatus.textContent = `Done in ${elapsed}s \u2014 ${formatSize(done.result.length)} saved as ${filename}`;
    showConvertProgress(1, 'Complete');
  } catch (err) {
    // A crash's message already reads "Worker error: ..."
    convertStatus.textContent = err.workerMessage ? `Error: ${err.message}` : err.message;
    convertStatus.className = 'status error';
  }
  convertWorking = false;
  for (const btn of convertActions.querySelectorAll('button')) btn.disabled = false;
  convertThreads.disabled = false;
}

async function startParallelConversion(targetFormat, baseName, ext, t0, numThreads) {
  try {
    const result = await compressISOParallel(convertFile, targetFormat, numThreads, showConvertProgress);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const filename = `${baseName}.${ext}`;
    download(result, filename);
    convertStatus.textContent = `Done in ${elapsed}s \u2014 ${formatSize(result.length)} saved as ${filename}`;
    showConvertProgress(1, 'Complete');
  } catch (err) {
    convertStatus.textContent = `Error: ${err.message}`;
    convertStatus.className = 'status error';
  }
  convertWorking = false;
  for (const btn of convertActions.querySelectorAll('button')) btn.disabled = false;
  convertThreads.disabled = false;
  convertActiveWorkers = [];
}
