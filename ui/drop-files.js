// Files from a drop, with any dropped folders opened up.
//
// dataTransfer.files lists a dropped folder as one unreadable entry, so a
// game kept in its own folder (a BIN and CUE, often beside a readme) could
// not be dropped whole. The drop's entries (webkitGetAsEntry, supported by
// Chrome, Firefox and Safari) let us walk into folders. Files found inside a
// folder are kept only if the tab accepts their type, so the readme is
// skipped; files dropped loose pass through so the tab can still say what is
// wrong with them.

/**
 * @param {DataTransfer} dataTransfer - from a drop event; read it before the first await
 * @param {string} accept - the tab's file input accept list, e.g. ".bin,.iso,.cue"
 * @returns {Promise<File[]>}
 */
async function collectDroppedFiles(dataTransfer, accept) {
  // Entries and the file list must be taken while the drop event is still being handled.
  const loose = Array.from(dataTransfer.files);
  const entries = Array.from(dataTransfer.items || [], item => item.kind === 'file' ? item.webkitGetAsEntry?.() : null);
  if (entries.length === 0 || entries.some(entry => !entry)) return loose;

  const accepted = accept.toLowerCase().split(',').map(ext => ext.trim());
  const isAccepted = (name) => accepted.some(ext => name.toLowerCase().endsWith(ext));
  const files = [];

  async function walk(entry, insideFolder) {
    if (entry.isFile && !insideFolder) {
      // A loose file comes from the plain list: WebKit cannot always read its entry.
      const file = loose.find(f => f.name === entry.name);
      if (file) files.push(file);
      return;
    }
    if (entry.isFile) {
      if (isAccepted(entry.name)) files.push(await new Promise((ok, fail) => entry.file(ok, fail)));
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      // readEntries hands back a batch at a time; an empty batch means the folder is done.
      const batch = await new Promise((ok, fail) => reader.readEntries(ok, fail));
      if (batch.length === 0) return;
      for (const child of batch) await walk(child, true);
    }
  }

  for (const entry of entries) await walk(entry, false);
  return files;
}
