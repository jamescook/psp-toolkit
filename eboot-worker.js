// EBOOT Web Worker — off-thread PBP construction
//
// Runs the full EBOOT build pipeline (assembler.js → buildEboot) in a Web
// Worker so the UI thread stays responsive during compression of large disc
// images (typically 500MB–700MB).
//
// After building, runs a verification pass (verify.js) to catch structural
// errors before returning the result. If verification fails, an error is
// posted back instead of the PBP data.
//
// Message protocol:
//   IN:  { files, title, discIds, compressionLevel, parentalLevel, region,
//          icon0, pic0, pic1, discInfo, preCompressed }
//   OUT: { type: 'progress', pct: 0-1, label: string }
//   OUT: { type: 'done', result: Uint8Array, verification, buildLog }
//   OUT: { type: 'error', message: string, buildLog? }
//
// The result Uint8Array is transferred (not copied) to avoid doubling memory.

import { buildEboot } from './eboot/assembler.js';
import { receiveFiles } from './remote-file.js';
import { verifyEboot } from './eboot/verify.js';

self.onmessage = async function(e) {
  const { files, title, discIds, compressionLevel, parentalLevel, region, icon0, pic0, pic1, discInfo, preCompressed } = receiveFiles(e.data);

  try {
    const onProgress = (pct, label) => {
      self.postMessage({ type: 'progress', pct, label });
    };

    const { pbp, buildLog } = await buildEboot({
      files,
      title,
      discIds,
      compressionLevel: compressionLevel ?? 5,
      parentalLevel: parentalLevel ?? 3,
      region: region ?? 0x8000,
      icon0: icon0 || undefined,
      pic0: pic0 || undefined,
      pic1: pic1 || undefined,
      discInfo: discInfo || undefined,
      preCompressed: preCompressed || undefined,
      onProgress,
    });

    // Verify before sending back
    const verification = verifyEboot(pbp);
    if (!verification.ok) {
      buildLog.verification = [{ status: 'FAIL', message: verification.error }];
      self.postMessage({ type: 'error', message: 'Verification failed: ' + verification.error, buildLog });
      return;
    }
    buildLog.verification = verification.checks.map(c => ({ status: 'PASS', message: c }));

    self.postMessage({
      type: 'done',
      result: pbp,
      verification: verification.checks,
      buildLog,
    }, [pbp.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
