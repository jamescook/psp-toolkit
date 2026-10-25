// Test fixtures — generate minimal PS1 disc images for testing
//
// Creates structurally valid ISO 9660 images with:
// - CD sync pattern (raw 2352-byte sectors)
// - Primary Volume Descriptor at sector 16
// - Root directory with SYSTEM.CNF
// - SYSTEM.CNF containing BOOT line with disc ID

const RAW_SECTOR_SIZE = 2352;
const ISO_SECTOR_SIZE = 2048;
const RAW_DATA_OFFSET = 24; // 12 sync + 4 header + 8 subheader

/**
 * Build a raw CD sector (Mode 2 Form 1, 2352 bytes).
 * @param {number} lba - Logical block address
 * @param {Uint8Array} data - Up to 2048 bytes of user data
 */
function buildRawSector(lba, data) {
  const sector = new Uint8Array(RAW_SECTOR_SIZE);
  // CD sync pattern: 00 FF FF FF FF FF FF FF FF FF FF 00
  sector[0] = 0x00;
  for (let i = 1; i <= 10; i++) sector[i] = 0xFF;
  sector[11] = 0x00;
  // MSF header (simplified — just encode LBA + 150 as M:S:F)
  const frames = lba + 150;
  const m = Math.floor(frames / (60 * 75));
  const s = Math.floor((frames % (60 * 75)) / 75);
  const f = frames % 75;
  sector[12] = toBcd(m);
  sector[13] = toBcd(s);
  sector[14] = toBcd(f);
  sector[15] = 2; // Mode 2
  // Subheader (8 bytes, zeros for Form 1)
  // User data at offset 24
  if (data) {
    sector.set(data.slice(0, ISO_SECTOR_SIZE), RAW_DATA_OFFSET);
  }
  return sector;
}

function toBcd(n) {
  return ((Math.floor(n / 10) & 0xF) << 4) | (n % 10 & 0xF);
}

function writeStr(buf, offset, str) {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}

function writeU32Both(buf, offset, val) {
  // ISO 9660 "both-endian" uint32: LE then BE
  buf[offset] = val & 0xFF;
  buf[offset + 1] = (val >> 8) & 0xFF;
  buf[offset + 2] = (val >> 16) & 0xFF;
  buf[offset + 3] = (val >> 24) & 0xFF;
  buf[offset + 4] = (val >> 24) & 0xFF;
  buf[offset + 5] = (val >> 16) & 0xFF;
  buf[offset + 6] = (val >> 8) & 0xFF;
  buf[offset + 7] = val & 0xFF;
}

function writeU16Both(buf, offset, val) {
  buf[offset] = val & 0xFF;
  buf[offset + 1] = (val >> 8) & 0xFF;
  buf[offset + 2] = (val >> 8) & 0xFF;
  buf[offset + 3] = val & 0xFF;
}

/**
 * Build a minimal ISO 9660 directory record.
 */
function buildDirRecord(name, lba, size, isDir) {
  const nameBytes = new TextEncoder().encode(name);
  const recLen = 33 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0); // pad to even
  const rec = new Uint8Array(recLen);
  rec[0] = recLen; // record length
  // LBA (both-endian)
  writeU32Both(rec, 2, lba);
  // Size (both-endian)
  writeU32Both(rec, 10, size);
  // Date/time: 7 bytes at offset 18 (zeros = 1900-01-01)
  // Flags
  rec[25] = isDir ? 0x02 : 0x00;
  // File unit size, interleave gap
  rec[26] = 0;
  rec[27] = 0;
  // Volume sequence number (both-endian)
  writeU16Both(rec, 28, 1);
  // Name length
  rec[32] = nameBytes.length;
  // Name
  rec.set(nameBytes, 33);
  return rec;
}

/**
 * Create a minimal raw PS1 disc image with proper ISO 9660 structure.
 *
 * @param {Object} opts
 * @param {string} opts.discId - e.g. "SLUS00896"
 * @param {string} [opts.volumeId] - PVD volume ID, default derived from discId
 * @param {number} [opts.dataSectors] - extra data sectors to pad (default 100)
 * @returns {Uint8Array} Raw 2352-byte sector disc image
 */
export function createMockPS1Disc(opts) {
  const discId = opts.discId || 'SLUS00000';
  const volumeId = opts.volumeId || 'TESTGAME';
  const dataSectors = opts.dataSectors ?? 100;

  // Layout:
  // Sectors 0-15: system area (lead-in, etc.)
  // Sector 16: Primary Volume Descriptor
  // Sector 17: Volume Descriptor Set Terminator
  // Sector 18: Root directory
  // Sector 19: SYSTEM.CNF
  // Sectors 20+: padding

  const totalSectors = 20 + dataSectors;
  const image = new Uint8Array(totalSectors * RAW_SECTOR_SIZE);

  // Fill system area with sync patterns
  for (let i = 0; i < totalSectors; i++) {
    const sectorOffset = i * RAW_SECTOR_SIZE;
    // Sync pattern
    image[sectorOffset] = 0x00;
    for (let j = 1; j <= 10; j++) image[sectorOffset + j] = 0xFF;
    image[sectorOffset + 11] = 0x00;
    // MSF
    const frames = i + 150;
    const m = Math.floor(frames / (60 * 75));
    const s = Math.floor((frames % (60 * 75)) / 75);
    const f = frames % 75;
    image[sectorOffset + 12] = toBcd(m);
    image[sectorOffset + 13] = toBcd(s);
    image[sectorOffset + 14] = toBcd(f);
    image[sectorOffset + 15] = 2; // Mode 2
  }

  // --- Primary Volume Descriptor (sector 16) ---
  const pvdOffset = 16 * RAW_SECTOR_SIZE + RAW_DATA_OFFSET;
  const pvd = new Uint8Array(ISO_SECTOR_SIZE);

  pvd[0] = 1; // Type: PVD
  writeStr(pvd, 1, 'CD001'); // Standard ID
  pvd[6] = 1; // Version

  // Volume ID at offset 40 (32 bytes, padded with spaces)
  const vidPadded = volumeId.padEnd(32, ' ');
  writeStr(pvd, 40, vidPadded);

  // Volume space size (both-endian) at offset 80
  writeU32Both(pvd, 80, totalSectors);

  // Volume set size at 120
  writeU16Both(pvd, 120, 1);
  // Volume sequence number at 124
  writeU16Both(pvd, 124, 1);
  // Logical block size at 128
  writeU16Both(pvd, 128, ISO_SECTOR_SIZE);

  // Root directory record at offset 156 (34 bytes)
  const rootDirRec = pvd.subarray(156, 190);
  rootDirRec[0] = 34; // record length
  writeU32Both(rootDirRec, 2, 18); // root dir LBA
  writeU32Both(rootDirRec, 10, ISO_SECTOR_SIZE); // root dir size
  rootDirRec[25] = 0x02; // directory flag
  writeU16Both(rootDirRec, 28, 1); // volume seq
  rootDirRec[32] = 1; // name length
  rootDirRec[33] = 0x01; // root name = \x01

  image.set(pvd, pvdOffset);

  // --- Volume Descriptor Set Terminator (sector 17) ---
  const vdstOffset = 17 * RAW_SECTOR_SIZE + RAW_DATA_OFFSET;
  image[vdstOffset] = 255; // Type: terminator
  writeStr(image, vdstOffset + 1, 'CD001');
  image[vdstOffset + 6] = 1;

  // --- Root Directory (sector 18) ---
  const rootOffset = 18 * RAW_SECTOR_SIZE + RAW_DATA_OFFSET;
  let dirPos = rootOffset;

  // "." entry
  const dotRec = buildDirRecord('\x00', 18, ISO_SECTOR_SIZE, true);
  image.set(dotRec, dirPos);
  dirPos += dotRec.length;

  // ".." entry
  const dotdotRec = buildDirRecord('\x01', 18, ISO_SECTOR_SIZE, true);
  image.set(dotdotRec, dirPos);
  dirPos += dotdotRec.length;

  // SYSTEM.CNF entry — build the content first to know the size
  const bootId = discId.slice(0, 4) + '_' + discId.slice(4, 7) + '.' + discId.slice(7);
  const cnfContent = `BOOT = cdrom:\\${bootId};1\r\n`;
  const cnfBytes = new TextEncoder().encode(cnfContent);

  const cnfRec = buildDirRecord('SYSTEM.CNF;1', 19, cnfBytes.length, false);
  image.set(cnfRec, dirPos);

  // --- SYSTEM.CNF (sector 19) ---
  const cnfOffset = 19 * RAW_SECTOR_SIZE + RAW_DATA_OFFSET;
  image.set(cnfBytes, cnfOffset);

  return image;
}

/**
 * Create a minimal PSP UMD image: cooked 2048-byte sectors, with the disc ID in
 * UMD_DATA.BIN at the root rather than in a SYSTEM.CNF.
 *
 * UMD_DATA.BIN starts "<serial>|<16 hex digits>|<4 digits>|G", as on a real
 * UMD (e.g. "ULUS-10277|4BEB7679A0E821C1|0001|G").
 *
 * @param {Object} opts
 * @param {string} opts.serial - e.g. "ULUS-10277"
 * @param {string} [opts.volumeId] - PVD volume ID
 * @returns {Uint8Array} Cooked 2048-byte sector disc image
 */
export function createMockPSPDisc(opts) {
  const totalSectors = 24;
  const image = new Uint8Array(totalSectors * ISO_SECTOR_SIZE);

  const pvd = image.subarray(16 * ISO_SECTOR_SIZE, 17 * ISO_SECTOR_SIZE);
  pvd[0] = 1;
  writeStr(pvd, 1, 'CD001');
  pvd[6] = 1;
  writeStr(pvd, 40, (opts.volumeId || 'UMD VIDEO').padEnd(32, ' '));
  writeU32Both(pvd, 80, totalSectors);
  writeU16Both(pvd, 128, ISO_SECTOR_SIZE);
  const rootDirRec = pvd.subarray(156, 190);
  rootDirRec[0] = 34;
  writeU32Both(rootDirRec, 2, 18);
  writeU32Both(rootDirRec, 10, ISO_SECTOR_SIZE);
  rootDirRec[25] = 0x02;
  rootDirRec[32] = 1;

  const terminator = 17 * ISO_SECTOR_SIZE;
  image[terminator] = 255;
  writeStr(image, terminator + 1, 'CD001');

  const umdData = new TextEncoder().encode(`${opts.serial}|4BEB7679A0E821C1|0001|G`);
  let dirPos = 18 * ISO_SECTOR_SIZE;
  for (const rec of [
    buildDirRecord('\x00', 18, ISO_SECTOR_SIZE, true),
    buildDirRecord('\x01', 18, ISO_SECTOR_SIZE, true),
    buildDirRecord('UMD_DATA.BIN;1', 19, umdData.length, false),
  ]) {
    image.set(rec, dirPos);
    dirPos += rec.length;
  }
  image.set(umdData, 19 * ISO_SECTOR_SIZE);
  return image;
}

/**
 * Create a CUE sheet and split BIN files for a multi-track disc.
 * Track 1 = data (MODE2/2352), Track 2 = audio.
 *
 * @param {Object} opts
 * @param {string} opts.discId - e.g. "SLUS00896"
 * @param {string} [opts.volumeId] - PVD volume ID
 * @param {number} [opts.dataSectors] - data track sectors (default 100)
 * @param {number} [opts.audioSectors] - audio track sectors (default 50)
 * @returns {{cueText: string, track1: Uint8Array, track2: Uint8Array, track1Name: string, track2Name: string}}
 */
export function createMultiTrackDisc(opts) {
  const dataSectors = opts.dataSectors ?? 100;
  const audioSectors = opts.audioSectors ?? 50;

  // Track 1: valid PS1 data track
  const track1 = createMockPS1Disc({
    discId: opts.discId,
    volumeId: opts.volumeId,
    dataSectors,
  });

  // Track 2: audio data (just random/zero bytes, 2352 bytes per sector)
  const track2 = new Uint8Array(audioSectors * RAW_SECTOR_SIZE);
  // Fill with a pattern so it's not all zeros (audio data)
  for (let i = 0; i < track2.length; i++) {
    track2[i] = (i * 7 + 13) & 0xFF;
  }

  const track1Name = 'Test Game (Track 1).bin';
  const track2Name = 'Test Game (Track 2).bin';

  const cueText = [
    `FILE "${track1Name}" BINARY`,
    '  TRACK 01 MODE2/2352',
    '    INDEX 01 00:00:00',
    `FILE "${track2Name}" BINARY`,
    '  TRACK 02 AUDIO',
    '    INDEX 00 00:00:00',
    '    INDEX 01 00:02:00',
    '',
  ].join('\n');

  return { cueText, track1, track2, track1Name, track2Name };
}
