// A queue of jobs from any tab, run one at a time.
//
// A tab turns its form into a job: what to run (run), the settings captured
// when it was added (settings), and a key that is the same for the same work
// on the same files, so adding it twice does nothing. Each job's outputs are
// handed to save() as soon as it finishes, so only one job's results are in
// memory at once.
//
// A waiting job can be taken back into its tab to edit (startEditing). It
// keeps its place, the queue runs the jobs behind it meanwhile, and
// finishEditing() puts it back with the new settings.
//
// A job's states: waiting → (editing → waiting) → running → saving → done,
// or failed / cancelled. Once saving, the files are being written and the
// job can no longer be cancelled.

const QUEUE_ACTIVE_STATES = new Set(['waiting', 'editing', 'running', 'saving']);

/**
 * @param {object} options
 * @param {function(Array<{name: string, data: Uint8Array}>): Promise<void>} options.save
 * @param {number} [options.maxJobs] - most jobs waiting, being edited or running at once
 */
function createJobQueue({ save, maxJobs = 10 }) {
  const jobs = [];
  const listeners = [];
  let nextId = 1;
  let running = null;

  const notify = () => { for (const fn of listeners) fn(); };
  const find = (id) => jobs.find(j => j.id === id);
  const isDuplicate = (key, exceptId) =>
    jobs.some(j => j.id !== exceptId && QUEUE_ACTIVE_STATES.has(j.state) && j.key === key);

  async function runNext() {
    if (running) return;
    const job = jobs.find(j => j.state === 'waiting');
    if (!job) return;

    running = job;
    job.state = 'running';
    job.progress = 0;
    job.message = '';
    job.attachments = [];
    job.controller = new AbortController();
    notify();

    try {
      // run resolves to its outputs, or to { outputs, note, attachments }: a
      // line for the user, and files (a build log) offered beside the result.
      const result = await job.run(job.settings, {
        signal: job.controller.signal,
        onProgress: (fraction, message) => {
          job.progress = fraction;
          if (message) job.message = message;
          notify();
        },
      });
      if (job.controller.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      const { outputs, note, attachments = [] } = Array.isArray(result) ? { outputs: result } : result;
      job.state = 'saving';
      job.message = 'Saving...';
      notify();
      await save(outputs);
      job.state = 'done';
      job.progress = 1;
      job.message = outputs.map(o => o.name).join(', ') + (note ? ` \u00b7 ${note}` : '');
      job.attachments = attachments;
    } catch (err) {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.message = job.state === 'cancelled' ? 'Cancelled' : err.message;
      job.attachments = err.attachments || [];
    }
    running = null;
    notify();
    runNext();
  }

  const schedule = () => Promise.resolve().then(runNext);

  return {
    /** Snapshot of every job, oldest first. */
    get jobs() {
      return jobs.map(({ id, kind, label, detail, state, progress, message, attachments = [] }) =>
        ({ id, kind, label, detail, state, progress, message, attachments }));
    },

    /** @returns {'added'|'duplicate'|'full'} */
    add(job) {
      if (isDuplicate(job.key)) return 'duplicate';
      if (jobs.filter(j => QUEUE_ACTIVE_STATES.has(j.state)).length >= maxJobs) return 'full';
      jobs.push({ ...job, id: nextId++, state: 'waiting', progress: 0, message: '' });
      notify();
      schedule();
      return 'added';
    },

    /** Drop a waiting or edited job, or cancel the running one. A saving job is past cancelling. */
    remove(id) {
      const job = find(id);
      if (!job || job.state === 'saving') return;
      if (job.state === 'running') {
        job.controller.abort();
        return;
      }
      jobs.splice(jobs.indexOf(job), 1);
      notify();
      schedule();
    },

    /** Take a waiting job back to edit; the queue skips it until it is finished or discarded. */
    startEditing(id) {
      const job = find(id);
      if (!job || job.state !== 'waiting') return null;
      job.state = 'editing';
      notify();
      return { id: job.id, kind: job.kind, settings: job.settings };
    },

    /** Put an edited job back in its place with new settings. @returns {'saved'|'duplicate'} */
    finishEditing(id, { key, label, detail, settings }) {
      const job = find(id);
      if (!job || job.state !== 'editing') return 'saved';
      if (isDuplicate(key, id)) return 'duplicate';
      Object.assign(job, { key, label, detail, settings, state: 'waiting' });
      notify();
      schedule();
      return 'saved';
    },

    /** Put an edited job back unchanged. */
    cancelEditing(id) {
      const job = find(id);
      if (!job || job.state !== 'editing') return;
      job.state = 'waiting';
      notify();
      schedule();
    },

    /** Forget jobs that are done, failed or cancelled. */
    clearFinished() {
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (!QUEUE_ACTIVE_STATES.has(jobs[i].state)) jobs.splice(i, 1);
      }
      notify();
    },

    subscribe(fn) {
      listeners.push(fn);
    },
  };
}
