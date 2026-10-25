// Files a worker reads through the page that sent them.
//
// WebKit (Safari) will not let a worker read a File when the page was opened
// from file:// — the offline download. So runWorker (ui/run-worker.js) never
// posts a File: it swaps each one for { remoteFile, name, size } and sends a
// MessagePort, and serves byte ranges from the page. receiveFiles() turns
// those back into stand-ins with the File methods the format code uses:
// name, size, slice(start, end).arrayBuffer() and arrayBuffer().
//
// Format code reads one small block at a time (2 KB for CSO, 0x9300 bytes for
// EBOOTs), so a stand-in asks the page for CHUNK_BYTES at once and serves the
// following reads from that.

export const CHUNK_BYTES = 4 * 1024 * 1024;

class RemoteFile {
  constructor(reader, index, name, size) {
    this.reader = reader;
    this.index = index;
    this.name = name;
    this.size = size;
    this.chunk = null; // { start, bytes } — the most recent CHUNK_BYTES read
  }

  slice(start = 0, end = this.size) {
    const clippedStart = Math.min(start, this.size);
    const clippedEnd = Math.max(clippedStart, Math.min(end, this.size));
    return { arrayBuffer: () => this.read(clippedStart, clippedEnd) };
  }

  arrayBuffer() {
    return this.read(0, this.size);
  }

  async read(start, end) {
    if (end - start >= CHUNK_BYTES) return this.reader(this.index, start, end);

    const cached = this.chunk;
    if (!cached || start < cached.start || end > cached.start + cached.bytes.byteLength) {
      const chunkEnd = Math.min(start + CHUNK_BYTES, this.size);
      this.chunk = { start, bytes: new Uint8Array(await this.reader(this.index, start, chunkEnd)) };
    }
    const offset = start - this.chunk.start;
    return this.chunk.bytes.slice(offset, offset + (end - start)).buffer;
  }
}

/** Ask the page for bytes over `port`; resolves to an ArrayBuffer. */
function portReader(port) {
  const pending = new Map();
  let nextId = 0;
  port.onmessage = (e) => {
    const { id, buffer, error } = e.data;
    const request = pending.get(id);
    pending.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve(buffer);
  };
  return (index, start, end) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ id, index, start, end });
  });
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Turn a job message from runWorker back into one holding readable files.
 * A message that carried no files is returned as it is.
 */
export function receiveFiles(data) {
  if (!isPlainObject(data) || !data.filePort) return data;
  const reader = portReader(data.filePort);

  const restore = (value) => {
    if (Array.isArray(value)) return value.map(restore);
    if (!isPlainObject(value)) return value;
    if (typeof value.remoteFile === 'number') {
      return new RemoteFile(reader, value.remoteFile, value.name, value.size);
    }
    const out = {};
    for (const [key, field] of Object.entries(value)) {
      if (key !== 'filePort') out[key] = restore(field);
    }
    return out;
  };
  return restore(data);
}
