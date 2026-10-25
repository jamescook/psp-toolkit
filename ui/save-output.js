// Where a finished job's files go: a folder the user picked, or Downloads.
//
// Chrome and Edge can write straight into a folder chosen once
// (showDirectoryPicker), which saves a "Save as" prompt per file and the
// browser's "allow multiple downloads?" question. Other browsers lack it, so
// the saver checks for the picker itself rather than the browser's name, and
// downloads there. A folder that stops accepting writes (permission revoked,
// folder deleted) falls back to downloading.

/**
 * @param {object} env
 * @param {function(Uint8Array, string): void} env.download - start a browser download
 * @param {function(object): Promise<object>} [env.showDirectoryPicker] - the browser's folder picker, if it has one
 */
function createOutputSaver({ download, showDirectoryPicker }) {
  let folder = null;

  async function findFreeName(dir, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      try {
        await dir.getFileHandle(candidate);
      } catch {
        return candidate;
      }
    }
  }

  async function writeToFolder(dir, { name, data }) {
    const handle = await dir.getFileHandle(await findFreeName(dir, name), { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  return {
    canChooseFolder: typeof showDirectoryPicker === 'function',

    /** The chosen folder's name, or null when saving to Downloads. */
    get folderName() {
      return folder?.name ?? null;
    },

    /** Ask the user for a folder. Returns its name, or null if they closed the picker. */
    async chooseFolder() {
      try {
        folder = await showDirectoryPicker({ id: 'psp-toolkit-output', mode: 'readwrite' });
        return folder.name;
      } catch {
        return null;
      }
    },

    useDownloads() {
      folder = null;
    },

    /** Save each output to the folder, or download it. */
    async save(outputs) {
      for (const output of outputs) {
        if (folder) {
          try {
            await writeToFolder(folder, output);
            continue;
          } catch {
            folder = null;
          }
        }
        download(output.data, output.name);
      }
    },
  };
}
