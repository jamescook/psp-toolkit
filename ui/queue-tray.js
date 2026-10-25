// The queue tray: one queue shared by the Convert, EBOOT, Patch and Save
// Manager tabs, shown along the bottom of the page.
//
// A tab builds a job from its form and hands it to submitJob(). The tray is
// absent until the first job, opens on wide screens and starts folded on a
// phone, and stays as an "All done" bar after the last job until closed.
//
// Edit takes a waiting job back into its tab: the tab registers a job source
// (registerJobSource) that can restore a job's settings into its form and
// relabel its main button, and its next submitJob() saves the changes into
// the job's place in the line instead of adding a new one.

const outputSaver = createOutputSaver({
  download,
  showDirectoryPicker: typeof window.showDirectoryPicker === 'function'
    ? (options) => window.showDirectoryPicker(options)
    : undefined,
});
const jobQueue = createJobQueue({ save: (outputs) => outputSaver.save(outputs) });

const queueTray = document.getElementById('queueTray');
const jobSources = new Map();
let editingJob = null;   // { id, kind } of the job loaded back into its tab
let trayFolded = null;   // null until the tray first appears

/**
 * @param {string} kind - the job kind a tab's jobs carry
 * @param {object} source
 * @param {string} source.tabId
 * @param {string} source.tabName - as the tray names the tab ("editing in the EBOOT tab")
 * @param {function(object): Promise<void>|void} source.restore - load a job's settings into the form
 * @param {function(boolean): void} source.setEditing - relabel the tab's main button
 * @param {function(): void} [source.clearAfterAdd] - empty a form that would otherwise add the
 *   next dropped file to the job just queued
 */
function registerJobSource(kind, source) {
  jobSources.set(kind, source);
}

/**
 * Identify a dropped file well enough to spot the same file added twice.
 * Not lastModified: a multi-BIN CUE game is joined into a new File on each drop.
 */
function fingerprintFile(file) {
  return `${file.name}|${file.size}`;
}

/**
 * Add a job to the queue, or save it over the job being edited in its tab.
 * Writes the outcome into the tab's status line.
 */
function submitJob(job, statusEl) {
  const source = jobSources.get(job.kind);
  let message;
  let isError = false;
  if (editingJob && editingJob.kind === job.kind) {
    const result = jobQueue.finishEditing(editingJob.id, job);
    if (result === 'duplicate') {
      message = 'Another job in the queue already does exactly this.';
      isError = true;
    } else {
      source.setEditing(false);
      editingJob = null;
      message = 'Changes saved. The job keeps its place in the queue.';
    }
  } else {
    const result = jobQueue.add(job);
    if (result === 'duplicate') {
      message = 'Already in the queue.';
    } else if (result === 'full') {
      message = 'The queue is full. Wait for a job to finish, then add this one.';
      isError = true;
    } else {
      source.clearAfterAdd?.();
      message = 'Added to the queue.';
    }
  }
  statusEl.textContent = message;
  statusEl.className = isError ? 'status error' : 'status';
  renderQueueTray();
}

async function beginEditingJob(id) {
  if (editingJob) discardJobEdit();
  const job = jobQueue.startEditing(id);
  if (!job) return;
  const source = jobSources.get(job.kind);
  editingJob = { id: job.id, kind: job.kind };
  switchTab(source.tabId);
  await source.restore(job.settings);
  source.setEditing(true);
  renderQueueTray();
}

function discardJobEdit() {
  if (!editingJob) return;
  jobQueue.cancelEditing(editingJob.id);
  jobSources.get(editingJob.kind).setEditing(false);
  editingJob = null;
  renderQueueTray();
}

// ── Rendering ────────────────────────────────────────────────────────────────

const trayCards = new Map(); // job id -> { root, name, pct, bar, fill, detail, actions, state }

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(label, testid, onClick, className = 'queue-btn') {
  const b = makeElement('button', className, label);
  b.type = 'button';
  b.dataset.testid = testid;
  b.addEventListener('click', onClick);
  return b;
}

/** The folded tray's one line: what is running and how far, and what waits behind it. */
function summarizeQueue(jobs) {
  const active = jobs.filter(j => QUEUE_ACTIVE_STATES.has(j.state));
  if (active.length === 0) {
    const failed = jobs.filter(j => j.state === 'failed').length;
    return failed ? `All done \u00b7 ${failed} failed` : 'All done';
  }
  const current = active.find(j => j.state === 'running' || j.state === 'saving');
  if (!current) return `${active.length} waiting`;
  const waiting = active.length - 1;
  return `${current.label} \u00b7 ${Math.round(current.progress * 100)}%${waiting ? ` \u00b7 +${waiting} waiting` : ''}`;
}

function describeJobState(job) {
  if (job.state === 'editing') return `${job.detail} \u00b7 editing in the ${jobSources.get(job.kind).tabName} tab`;
  if (job.state === 'waiting') return `${job.detail} \u00b7 waiting`;
  return job.message ? `${job.detail} \u00b7 ${job.message}` : job.detail;
}

function buildCardActions(job) {
  if (job.state === 'running') return [makeButton('Cancel', 'queue-cancel', () => jobQueue.remove(job.id))];
  if (job.state === 'saving') return [];
  if (job.state === 'editing') return [makeButton('Discard changes', 'queue-discard', discardJobEdit)];
  return [
    makeButton('Edit', 'queue-edit', () => beginEditingJob(job.id)),
    makeButton('Remove', 'queue-remove', () => jobQueue.remove(job.id)),
  ];
}

function updateCard(job) {
  let card = trayCards.get(job.id);
  if (!card) {
    const root = makeElement('li', 'queue-job');
    root.dataset.testid = 'queue-job';
    const head = makeElement('div', 'queue-job-head');
    const name = makeElement('span', 'queue-job-name');
    const pct = makeElement('span', 'queue-job-pct');
    head.append(name, pct);
    const bar = makeElement('div', 'queue-job-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const fill = makeElement('div', 'queue-job-fill');
    bar.append(fill);
    const foot = makeElement('div', 'queue-job-foot');
    const detail = makeElement('span', 'queue-job-detail');
    const actions = makeElement('div', 'queue-job-actions');
    foot.append(detail, actions);
    root.append(head, bar, foot);
    card = { root, name, pct, bar, fill, detail, actions, state: null };
    trayCards.set(job.id, card);
  }
  const percent = Math.round(job.progress * 100);
  const working = job.state === 'running' || job.state === 'saving';
  card.root.dataset.state = job.state;
  card.name.textContent = job.label;
  card.pct.textContent = working ? `${percent}%` : '';
  card.bar.hidden = !working;
  card.bar.setAttribute('aria-label', `${job.label} progress`);
  card.bar.setAttribute('aria-valuenow', String(percent));
  card.fill.style.width = `${percent}%`;
  card.detail.textContent = describeJobState(job);
  // Buttons are rebuilt only when the state changes, so a progress update
  // never replaces a button mid-click.
  if (card.state !== job.state) {
    card.actions.replaceChildren(...buildCardActions(job));
    card.state = job.state;
  }
  return card.root;
}

function buildDestinationLine() {
  const line = makeElement('div', 'queue-dest');
  if (!outputSaver.canChooseFolder) {
    line.textContent = 'Each file downloads as its job finishes.';
    return line;
  }
  if (outputSaver.folderName) {
    line.append(makeElement('span', null, `Saving into \u201c${outputSaver.folderName}\u201d`), ' ',
      makeButton('Use Downloads', 'queue-use-downloads', () => { outputSaver.useDownloads(); renderQueueTray(); }, 'queue-link'));
  } else {
    line.append(makeElement('span', null, 'Saving to Downloads'), ' ',
      makeButton('Choose a folder', 'queue-choose-folder', async () => { await outputSaver.chooseFolder(); renderQueueTray(); }, 'queue-link'));
  }
  return line;
}

function buildFinishedLine(job) {
  const item = makeElement('li', `queue-finished-item queue-${job.state}`);
  item.dataset.testid = 'queue-finished';
  item.dataset.state = job.state;
  const outcome = job.state === 'done' ? `saved ${job.message}`
    : job.state === 'cancelled' ? 'cancelled'
    : `failed: ${job.message}`;
  item.append(makeElement('span', null, `${job.label} \u00b7 ${outcome}`));
  for (const attachment of job.attachments) {
    item.append(' ', makeButton(attachment.label || attachment.name, 'queue-attachment',
      () => download(attachment.data, attachment.name), 'queue-link'));
  }
  return item;
}

function renderQueueTray() {
  const jobs = jobQueue.jobs;
  if (jobs.length === 0) {
    queueTray.hidden = true;
    trayFolded = null;
    return;
  }
  if (trayFolded === null) trayFolded = window.matchMedia('(max-width: 700px)').matches;
  queueTray.hidden = false;
  queueTray.classList.toggle('folded', trayFolded);

  const active = jobs.filter(j => QUEUE_ACTIVE_STATES.has(j.state));
  const finished = jobs.filter(j => !QUEUE_ACTIVE_STATES.has(j.state));
  const current = active.find(j => j.state === 'running' || j.state === 'saving');

  // Header: the fold toggle carries a one-line summary.
  const toggle = makeButton('', 'queue-toggle', () => { trayFolded = !trayFolded; renderQueueTray(); }, 'queue-toggle');
  toggle.setAttribute('aria-expanded', String(!trayFolded));
  toggle.setAttribute('aria-label', trayFolded ? 'Show queue' : 'Fold queue');
  const chevron = makeElement('span', 'queue-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  toggle.append(makeElement('span', 'queue-title', 'Queue'), makeElement('span', 'queue-summary', summarizeQueue(jobs)), chevron);

  const head = makeElement('div', 'queue-head');
  head.append(toggle);
  if (active.length === 0) {
    head.append(makeButton('Close', 'queue-close', () => { jobQueue.clearFinished(); renderQueueTray(); }));
  }

  const parts = [head];
  if (trayFolded && current) {
    const bar = makeElement('div', 'queue-job-bar queue-folded-bar');
    const fill = makeElement('div', 'queue-job-fill');
    fill.style.width = `${Math.round(current.progress * 100)}%`;
    bar.append(fill);
    parts.push(bar);
  }
  if (!trayFolded) {
    const list = makeElement('ol', 'queue-jobs');
    const keep = new Set(active.map(j => j.id));
    for (const id of trayCards.keys()) if (!keep.has(id)) trayCards.delete(id);
    list.append(...active.map(updateCard));
    parts.push(list);
    if (finished.length) {
      const done = makeElement('ul', 'queue-finished');
      done.append(...finished.map(buildFinishedLine));
      parts.push(done);
    }
    parts.push(buildDestinationLine());
  }

  const inner = makeElement('div', 'queue-inner');
  inner.append(...parts);
  queueTray.replaceChildren(inner);
}

// Progress arrives many times a second. Once the tray's layout is built, a
// progress-only change updates the summary and the working card in place
// rather than rebuilding the tray (which would replace buttons under the pointer).
let lastTrayShape = '';
jobQueue.subscribe(() => {
  const jobs = jobQueue.jobs;
  const shape = `${trayFolded}|${jobs.map(j => `${j.id}:${j.state}`).join(',')}|${outputSaver.folderName}`;
  const current = jobs.find(j => j.state === 'running' || j.state === 'saving');
  if (shape === lastTrayShape && current) {
    const summary = queueTray.querySelector('.queue-summary');
    if (summary) summary.textContent = summarizeQueue(jobs);
    if (trayFolded) {
      const fill = queueTray.querySelector('.queue-folded-bar .queue-job-fill');
      if (fill) fill.style.width = `${Math.round(current.progress * 100)}%`;
    } else {
      updateCard(current);
    }
    return;
  }
  lastTrayShape = shape;
  renderQueueTray();
});

window.addEventListener('beforeunload', (e) => {
  if (jobQueue.jobs.some(j => QUEUE_ACTIVE_STATES.has(j.state))) {
    e.preventDefault();
    e.returnValue = '';
  }
});
