// Disc ID auto-detection from PS1 ISO/BIN
//
// Reads the ISO 9660 filesystem on a PS1 disc image to find SYSTEM.CNF, then
// parses the BOOT line to extract the disc ID (e.g. "SCUS94163").
//
// How it works:
//   1. Detect raw (2352 bytes/sector) vs cooked (2048 bytes/sector) image
//   2. Read the Primary Volume Descriptor (PVD) at sector 16
//   3. Walk the root directory to find SYSTEM.CNF
//   4. Parse "BOOT = cdrom:\SLUS_008.92;1" → disc ID "SLUS00892"
//
// A PSP UMD has no SYSTEM.CNF; its root holds UMD_DATA.BIN, which starts with
// the serial: "ULUS-10277|4BEB7679A0E821C1|0001|G" → disc ID "ULUS10277".
//
// Also extracts the volume ID from the PVD (offset 40, 32 bytes) as a
// fallback game title, though many PS1 games leave this empty.
//
// ISO 9660: https://en.wikipedia.org/wiki/ISO_9660
// PS1 SYSTEM.CNF: https://psx-spx.consoledev.net/cdromdrive/#ings-after-ings

const ISO_SECTOR_SIZE = 2048;  // Cooked sector: user data only
const RAW_SECTOR_SIZE = 2352;  // Raw sector: sync + header + subheader + data + EDC/ECC
const RAW_DATA_OFFSET = 24;    // Mode 2 Form 1: 12 sync + 4 header + 8 subheader

/**
 * Auto-detect the disc ID and title from a PS1 disc image.
 *
 * @param {File} file - The disc image file (.bin or .iso)
 * @returns {Promise<{discId: string, bootFile: string, title: string} | null>}
 *   discId: normalized ID without punctuation (e.g. "SCUS94163")
 *   bootFile: raw filename from SYSTEM.CNF (e.g. "SCUS_941.63"); null for a PSP UMD
 *   title: volume ID from PVD, title-cased (may be empty for some games)
 */
export async function detectDiscId(file) {
  const isRaw = await isRawImage(file);
  const sectorSize = isRaw ? RAW_SECTOR_SIZE : ISO_SECTOR_SIZE;
  const dataOffset = isRaw ? RAW_DATA_OFFSET : 0;

  // Primary Volume Descriptor is at sector 16
  const pvd = await readSector(file, 16, sectorSize, dataOffset);
  if (!pvd) return null;

  // Check PVD signature: type 1, "CD001"
  if (pvd[0] !== 1) return null;
  const sig = String.fromCharCode(pvd[1], pvd[2], pvd[3], pvd[4], pvd[5]);
  if (sig !== 'CD001') return null;

  // Volume ID at PVD offset 40, 32 bytes (ISO 9660 spec)
  const rawVolumeId = String.fromCharCode(...pvd.slice(40, 72)).trim();
  // Title-case the volume ID: "TRON_BONNE" -> "Tron Bonne"
  const title = rawVolumeId
    .replace(/_/g, ' ')
    .replace(/[A-Z]+/g, w => w[0] + w.slice(1).toLowerCase());

  // Root directory record starts at offset 156 in PVD, 34 bytes
  const rootDirRecord = pvd.slice(156, 190);
  const rootLba = readUint32LE(rootDirRecord, 2);
  const rootSize = readUint32LE(rootDirRecord, 10);

  // Read root directory
  const rootSectors = Math.ceil(rootSize / ISO_SECTOR_SIZE);
  let systemCnfLba = 0;
  let systemCnfSize = 0;
  let umdDataLba = 0;

  for (let s = 0; s < rootSectors; s++) {
    const dirData = await readSector(file, rootLba + s, sectorSize, dataOffset);
    if (!dirData) break;

    let pos = 0;
    while (pos < ISO_SECTOR_SIZE) {
      const recLen = dirData[pos];
      if (recLen === 0) break;

      const nameLen = dirData[pos + 32];
      const name = String.fromCharCode(...dirData.slice(pos + 33, pos + 33 + nameLen));
      const cleanName = name.split(';')[0].toUpperCase();

      if (cleanName === 'SYSTEM.CNF') {
        systemCnfLba = readUint32LE(dirData, pos + 2);
        systemCnfSize = readUint32LE(dirData, pos + 10);
        break;
      }
      if (cleanName === 'UMD_DATA.BIN') umdDataLba = readUint32LE(dirData, pos + 2);
      pos += recLen;
    }
    if (systemCnfLba) break;
  }

  // A PSP UMD has no SYSTEM.CNF: UMD_DATA.BIN starts "ULUS-10277|<hex>|0001|G".
  if (!systemCnfLba && umdDataLba) {
    const umdData = await readSector(file, umdDataLba, sectorSize, dataOffset);
    const serial = umdData && new TextDecoder('ascii').decode(umdData.slice(0, 32)).match(/^([A-Z]{4})-(\d{5})\|/);
    return serial ? { discId: serial[1] + serial[2], bootFile: null, title } : null;
  }

  if (!systemCnfLba) return null;

  // Read SYSTEM.CNF
  const cnfData = await readSector(file, systemCnfLba, sectorSize, dataOffset);
  if (!cnfData) return null;

  const cnfText = new TextDecoder('ascii').decode(cnfData.slice(0, Math.min(systemCnfSize, ISO_SECTOR_SIZE)));

  // Parse BOOT line: "BOOT = cdrom:\SCUS_941.63;1" or similar
  const bootMatch = cnfText.match(/BOOT\s*=\s*cdrom[:\d]*\\?\\?([A-Z]{4}_\d{3}\.\d{2})/i);
  if (!bootMatch) return null;

  const bootFile = bootMatch[1]; // e.g. "SCUS_941.63"
  const discId = bootFile.replace(/[_.]/g, ''); // e.g. "SCUS94163"

  return { discId, bootFile, title };
}

/**
 * Detect whether a disc image is raw (2352 bytes/sector) by checking for the
 * CD-ROM sync pattern at the start: 00 FF FF FF FF FF FF FF FF FF FF 00.
 * If absent, the image is assumed to be cooked (2048 bytes/sector, ISO only).
 */
export async function isRawImage(file) {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return header[0] === 0x00 && header[1] === 0xFF && header[2] === 0xFF &&
         header[3] === 0xFF && header[11] === 0x00;
}

/** Read 2048 bytes of user data from a given LBA (logical block address). */
async function readSector(file, lba, sectorSize, dataOffset) {
  const start = lba * sectorSize + dataOffset;
  const end = start + ISO_SECTOR_SIZE;
  if (end > file.size) return null;
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Read a little-endian uint32 from a byte array. */
function readUint32LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | ((buf[offset + 3] << 24) >>> 0);
}
