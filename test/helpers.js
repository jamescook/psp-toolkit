// Test helpers — set up globals and provide mock File API for Node.js

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// zlib.js sets globalThis.deflateRaw/inflateRaw when loaded
require('../vendor/zlib.cjs');

// Mock File API matching the browser File interface used by eboot modules
export class MockFile {
  constructor(data, name = 'test.bin') {
    this._data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.name = name;
    this.size = this._data.length;
  }

  slice(start, end) {
    const sliced = this._data.slice(start, end);
    return {
      arrayBuffer() {
        return Promise.resolve(sliced.buffer.slice(
          sliced.byteOffset,
          sliced.byteOffset + sliced.byteLength
        ));
      },
    };
  }

  arrayBuffer() {
    return Promise.resolve(this._data.buffer.slice(
      this._data.byteOffset,
      this._data.byteOffset + this._data.byteLength
    ));
  }
}

// Re-export modules for convenience
export { ASSETS } from '../eboot/assets.js';
export { buildSFO } from '../eboot/sfo.js';
export { buildPBP } from '../eboot/pbp.js';
export { parseCue } from '../eboot/cue.js';
export { generateToc, generateTocFromCue, toBcd, framesToMsfBcd } from '../eboot/toc.js';
export { detectDiscId, isRawImage } from '../eboot/discid.js';
export { compressBlocks, buildPsisoimg } from '../eboot/psisoimg.js';
export { buildPstitleimg, buildPsar } from '../eboot/pstitleimg.js';
export { buildEboot } from '../eboot/assembler.js';
export { verifyEboot } from '../eboot/verify.js';
export { parseMcr, MCR_SIZE, BLOCK_SIZE, HEADER_SIZE, MAX_SLOTS } from '../save/mcr.js';
export { stripGmeHeader, GME_HEADER_SIZE, GME_SIZE, GME_MAGIC } from '../save/gme.js';
export { aes128EncryptBlock, aes128DecryptBlock } from '../save/aes-ecb.js';
export {
  generateHash, buildVmp,
  VMP_HEADER_BYTES, MCR_OFFSET, VMP_SEED_OFFSET, VMP_HASH_OFFSET, VMP_SIZE,
} from '../save/vmp.js';
