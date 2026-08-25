#!/usr/bin/env node
// Debug tool: trace VCDIFF instruction execution and compare against expected output.
// Usage: node tools/debug-vcdiff.js <source> <patch> <expected> [window_num]
//
// Traces every instruction in the specified window (default 0), comparing
// output bytes against the expected file. Stops at first mismatch and dumps
// full context: instruction details, address cache state, source/target bytes.

import fs from 'fs';
import { StreamingXZDecoder } from '../patch/xz.js';

const VCD_DECOMPRESS = 0x01;
const VCD_CODETABLE  = 0x02;
const VCD_APPHEADER  = 0x04;

const NOOP = 0, ADD = 1, RUN = 2, COPY = 3;
const TYPE_NAMES = ['NOOP', 'ADD', 'RUN', 'COPY'];

const defaultTable = buildDefaultCodeTable();

function buildDefaultCodeTable() {
  const t = new Array(256);
  let idx = 0;
  t[idx++] = [RUN, 0, 0, NOOP, 0, 0];
  t[idx++] = [ADD, 0, 0, NOOP, 0, 0];
  for (let s = 1; s <= 17; s++) t[idx++] = [ADD, s, 0, NOOP, 0, 0];
  for (let m = 0; m <= 8; m++) {
    t[idx++] = [COPY, 0, m, NOOP, 0, 0];
    for (let s = 4; s <= 18; s++) t[idx++] = [COPY, s, m, NOOP, 0, 0];
  }
  for (let m = 0; m <= 5; m++) {
    for (let a = 1; a <= 4; a++) {
      for (let c = 4; c <= 6; c++) {
        t[idx++] = [ADD, a, 0, COPY, c, m];
      }
    }
  }
  for (let m = 6; m <= 8; m++) {
    for (let a = 1; a <= 4; a++) {
      t[idx++] = [ADD, a, 0, COPY, 4, m];
    }
  }
  for (let m = 0; m <= 8; m++) {
    t[idx++] = [COPY, 4, m, ADD, 1, 0];
  }
  return t;
}

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u8() { return this.buf[this.pos++]; }
  integer() {
    let val = 0, b;
    do {
      b = this.buf[this.pos++];
      val = val * 128 + (b & 0x7F);
    } while (b & 0x80);
    return val;
  }
  bytes(n) {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  get done() { return this.pos >= this.buf.length; }
}

function decompressSection(reader, sectionLen, isCompressed, streamDecoder) {
  const raw = reader.bytes(sectionLen);
  if (!isCompressed) return raw;
  const sectionReader = new Reader(raw);
  const decompressedSize = sectionReader.integer();
  const compressed = raw.subarray(sectionReader.pos);
  return streamDecoder.decode(compressed);
}

function describeAddrMode(mode, rawVal, here, nearBefore) {
  if (mode === 0) return `SELF raw=${rawVal}`;
  if (mode === 1) return `HERE raw=${rawVal} (here=${here}-${rawVal})`;
  if (mode <= 5) return `NEAR[${mode - 2}]=${nearBefore[mode - 2]}+${rawVal}`;
  return `SAME[${mode - 6}][${rawVal}]`;
}

function hexBytes(arr, start, len) {
  const s = [];
  for (let i = 0; i < len && start + i < arr.length; i++) {
    s.push(arr[start + i].toString(16).padStart(2, '0'));
  }
  return s.join(' ');
}

// ── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('Usage: node tools/debug-vcdiff.js <source> <patch> <expected> [window_num]');
  process.exit(1);
}

const source = new Uint8Array(fs.readFileSync(args[0]));
const patch = new Uint8Array(fs.readFileSync(args[1]));
const expected = new Uint8Array(fs.readFileSync(args[2]));
const targetWinNum = parseInt(args[3] || '0', 10);

const r = new Reader(patch);

// Header
r.u8(); r.u8(); r.u8(); // magic
r.u8(); // version
const hdrIndicator = r.u8();
let hasSecondaryCompression = false;
if (hdrIndicator & VCD_DECOMPRESS) {
  const compId = r.u8();
  if (compId === 2) hasSecondaryCompression = true;
}
if (hdrIndicator & VCD_CODETABLE) { const len = r.integer(); r.bytes(len); }
if (hdrIndicator & VCD_APPHEADER) { const len = r.integer(); r.bytes(len); }

let dataDecoder, instDecoder, addrDecoder;
if (hasSecondaryCompression) {
  dataDecoder = new StreamingXZDecoder();
  instDecoder = new StreamingXZDecoder();
  addrDecoder = new StreamingXZDecoder();
}

let winNum = 0;
let globalOutputOff = 0;

while (!r.done) {
  const winIndicator = r.u8();
  const hasSource = !!(winIndicator & 0x01);
  const hasTarget = !!(winIndicator & 0x02);
  const hasAdler32 = !!(winIndicator & 0x04);

  let srcLen = 0, srcOff = 0, srcData = null;
  if (hasSource || hasTarget) {
    srcLen = r.integer();
    srcOff = r.integer();
    if (hasSource) srcData = source.subarray(srcOff, srcOff + srcLen);
  }

  const deltaLen = r.integer();
  const deltaEnd = r.pos + deltaLen;
  const targetWindowLen = r.integer();
  const indicator = r.u8();
  const dataLen = r.integer();
  const instLen = r.integer();
  const addrLen = r.integer();

  if (hasAdler32 && dataLen + instLen + addrLen + 4 <= deltaEnd - r.pos) {
    r.bytes(4);
  }

  let dataSection, instSection, addrSection;
  if (indicator !== 0 && hasSecondaryCompression) {
    dataSection = decompressSection(r, dataLen, indicator & 0x01, dataDecoder);
    instSection = decompressSection(r, instLen, indicator & 0x02, instDecoder);
    addrSection = decompressSection(r, addrLen, indicator & 0x04, addrDecoder);
  } else {
    dataSection = r.bytes(dataLen);
    instSection = r.bytes(instLen);
    addrSection = r.bytes(addrLen);
  }

  if (winNum === targetWinNum) {
    console.log(`=== Window ${winNum} ===`);
    console.log(`  srcOff=${srcOff} srcLen=${srcLen} targetLen=${targetWindowLen}`);
    console.log(`  dataSection=${dataSection.length} instSection=${instSection.length} addrSection=${addrSection.length}`);
    console.log(`  globalOutputOff=${globalOutputOff}`);
    console.log();

    const targetWindow = new Uint8Array(targetWindowLen);
    const instReader = new Reader(instSection);
    const dataReader = new Reader(dataSection);
    const addrReader = new Reader(addrSection);

    const near = [0, 0, 0, 0];
    let nearIdx = 0;
    const same = new Array(256 * 3).fill(0);
    let tPos = 0;
    let instNum = 0;
    let mismatchFound = false;

    let lastDecodedAddr = null;

    function decodeAddress(mode, here) {
      const addrPos = addrReader.pos;
      const nearBefore = [...near];
      const nearIdxBefore = nearIdx;
      let addr, rawVal;
      if (mode === 0) {
        rawVal = addrReader.integer();
        addr = rawVal;
      } else if (mode === 1) {
        rawVal = addrReader.integer();
        addr = here - rawVal;
      } else if (mode >= 2 && mode <= 5) {
        rawVal = addrReader.integer();
        addr = near[mode - 2] + rawVal;
      } else {
        rawVal = addrReader.u8();
        addr = same[(mode - 6) * 256 + rawVal];
      }
      near[nearIdx] = addr;
      nearIdx = (nearIdx + 1) % 4;
      same[addr % (256 * 3)] = addr;
      lastDecodedAddr = { addr, addrPos, mode, rawVal, here, nearBefore, nearIdxBefore };
      return { addr, addrPos };
    }

    function checkOutput(startPos, len) {
      for (let i = 0; i < len; i++) {
        const globalPos = globalOutputOff + startPos + i;
        if (globalPos < expected.length && targetWindow[startPos + i] !== expected[globalPos]) {
          return { pos: startPos + i, got: targetWindow[startPos + i], want: expected[globalPos], globalPos };
        }
      }
      return null;
    }

    const copyLog = [];

    function execInst(type, size, mode, halfLabel) {
      if (type === NOOP) return;
      const startTPos = tPos;

      if (type === ADD) {
        const dataPos = dataReader.pos;
        targetWindow.set(dataReader.bytes(size), tPos);
        tPos += size;
        const mismatch = checkOutput(startTPos, size);
        if (mismatch && !mismatchFound) {
          mismatchFound = true;
          console.log(`!!! MISMATCH at inst #${instNum} ${halfLabel} !!!`);
          console.log(`  ADD size=${size} from dataSection[${dataPos}]`);
          console.log(`  tPos=${startTPos}→${tPos} globalPos=${mismatch.globalPos}`);
          console.log(`  got=0x${mismatch.got.toString(16)} want=0x${mismatch.want.toString(16)}`);
          console.log(`  data bytes: ${hexBytes(dataSection, dataPos, Math.min(size, 16))}`);
          console.log(`  expected:   ${hexBytes(expected, globalOutputOff + startTPos, Math.min(size, 16))}`);
          dumpCopyLog();
          process.exit(1);
        }
      } else if (type === RUN) {
        const val = dataReader.u8();
        targetWindow.fill(val, tPos, tPos + size);
        tPos += size;
        const mismatch = checkOutput(startTPos, size);
        if (mismatch && !mismatchFound) {
          mismatchFound = true;
          console.log(`!!! MISMATCH at inst #${instNum} ${halfLabel} !!!`);
          console.log(`  RUN val=0x${val.toString(16)} size=${size}`);
          console.log(`  tPos=${startTPos}→${tPos} globalPos=${mismatch.globalPos}`);
          console.log(`  got=0x${mismatch.got.toString(16)} want=0x${mismatch.want.toString(16)}`);
          dumpCopyLog();
          process.exit(1);
        }
      } else if (type === COPY) {
        const here = srcLen + startTPos;
        const { addr, addrPos } = decodeAddress(mode, here);

        copyLog.push({
          instNum, half: halfLabel, mode, size, addr, here, tPos: startTPos,
          addrPos, rawVal: lastDecodedAddr.rawVal,
          nearBefore: lastDecodedAddr.nearBefore,
          nearIdxBefore: lastDecodedAddr.nearIdxBefore,
        });

        if (addr < srcLen) {
          const copyEnd = addr + size;
          if (copyEnd <= srcLen) {
            targetWindow.set(srcData.subarray(addr, copyEnd), tPos);
          } else {
            const fromSrc = srcLen - addr;
            targetWindow.set(srcData.subarray(addr, srcLen), tPos);
            for (let i = fromSrc; i < size; i++) {
              targetWindow[tPos + i] = targetWindow[tPos + i - fromSrc];
            }
          }
          tPos += size;
        } else {
          const tAddr = addr - srcLen;
          if (tAddr + size <= tPos) {
            targetWindow.copyWithin(tPos, tAddr, tAddr + size);
          } else {
            for (let i = 0; i < size; i++) {
              targetWindow[tPos + i] = targetWindow[tAddr + i];
            }
          }
          tPos += size;
        }

        const mismatch = checkOutput(startTPos, size);
        if (mismatch && !mismatchFound) {
          mismatchFound = true;
          console.log(`!!! MISMATCH at inst #${instNum} ${halfLabel} !!!`);
          console.log(`  COPY mode=${mode} size=${size} addr=${addr} here=${here} addrStreamPos=${addrPos}`);
          console.log(`  ${describeAddrMode(mode, lastDecodedAddr.rawVal, here, lastDecodedAddr.nearBefore)}`);
          console.log(`  tPos=${startTPos}→${tPos} globalPos=${mismatch.globalPos}`);
          console.log(`  got=0x${mismatch.got.toString(16)} want=0x${mismatch.want.toString(16)}`);
          console.log(`  addr < srcLen: ${addr < srcLen}`);
          if (addr < srcLen) {
            console.log(`  source bytes at addr: ${hexBytes(srcData, addr, Math.min(size, 16))}`);
          } else {
            const tAddr = addr - srcLen;
            console.log(`  target addr: ${tAddr}`);
            console.log(`  target bytes at tAddr: ${hexBytes(targetWindow, tAddr, Math.min(size, 16))}`);
          }
          console.log(`  expected bytes: ${hexBytes(expected, globalOutputOff + startTPos, Math.min(size, 16))}`);
          dumpCopyLog();
          process.exit(1);
        }
      }
    }

    function dumpCopyLog() {
      console.log();
      console.log('  All COPY instructions up to failure:');
      for (const e of copyLog) {
        const modeDesc = describeAddrMode(e.mode, e.rawVal, e.here, e.nearBefore);
        console.log(`    #${e.instNum} ${e.half}: COPY m${e.mode} sz=${e.size} addr=${e.addr} tPos=${e.tPos} aPos=${e.addrPos} | ${modeDesc} | near=[${e.nearBefore}] ni=${e.nearIdxBefore}`);
      }
    }

    const instLog = [];

    while (!instReader.done) {
      const instPos = instReader.pos;
      const code = instReader.u8();
      const [type1, size1, mode1, type2, size2, mode2] = defaultTable[code];

      const s1 = size1 || (type1 !== NOOP ? instReader.integer() : 0);
      execInst(type1, s1, mode1, 'half1');

      const s2 = size2 || (type2 !== NOOP ? instReader.integer() : 0);
      execInst(type2, s2, mode2, 'half2');

      instNum++;
    }

    if (!mismatchFound) {
      // Verify full window
      let allGood = true;
      for (let i = 0; i < targetWindowLen; i++) {
        const gi = globalOutputOff + i;
        if (gi < expected.length && targetWindow[i] !== expected[gi]) {
          console.log(`Window ${winNum} mismatch at byte ${i} (global ${gi}): got 0x${targetWindow[i].toString(16)} want 0x${expected[gi].toString(16)}`);
          allGood = false;
          break;
        }
      }
      if (allGood) {
        console.log(`Window ${winNum}: ${instNum} instructions, ${targetWindowLen} bytes — ALL MATCH`);
      }
    }
    break; // Only trace the target window
  }

  r.pos = deltaEnd;
  globalOutputOff += targetWindowLen;
  winNum++;
}
