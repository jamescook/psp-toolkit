#!/usr/bin/env node
// Verify our VMP signing output against apollo-psp's real, unmodified
// vmp_resign.c -- an independent oracle, not a re-derivation of our own
// understanding of the algorithm.
//
// Usage:
//   node scripts/verify-vmp-oracle.cjs --oracle <path-to-apollo-psp-checkout> --gme <path-to-.gme-file>
//
// Requires a C compiler and mbedtls (aes.h/sha1.h) on this machine -- e.g.
// `brew install mbedtls` on macOS, `apt install libmbedtls-dev` on Debian/
// Ubuntu. Takes explicit --oracle/--gme paths rather than hardcoding any --
// see scripts/vmp-oracle/ for the small compile-time shim this needs and why
// (apollo-psp's real utils.h expects an unvendored sibling-project header).
//
// What this checks: build a .vmp from the given .gme using our JS module,
// then ask the REAL vmp_resign() (compiled from apollo-psp's actual source)
// to re-sign a copy of it. vmp_resign() recomputes the seed+signature fields
// from the memory-card payload using its own generateHash() -- if our JS
// signing logic is correct, re-signing is a no-op and the file comes back
// byte-identical. Any mismatch means our port has a bug.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function usageAndExit(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    'usage: node scripts/verify-vmp-oracle.cjs --oracle <path-to-apollo-psp-checkout> --gme <path-to-.gme-file>'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { oracle: null, gme: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--oracle') args.oracle = argv[++i];
    else if (argv[i] === '--gme') args.gme = argv[++i];
  }
  return args;
}

function hex(buf) {
  return Buffer.from(buf).toString('hex');
}

function requireFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    usageAndExit(`${label} not found: ${filePath}`);
  }
}

function detectCompiler() {
  const cc = process.env.CC || 'cc';
  try {
    execFileSync(cc, ['--version'], { stdio: 'ignore' });
  } catch {
    usageAndExit(
      `no C compiler found ("${cc}" failed to run). Install one (e.g. Xcode Command Line Tools on macOS, ` +
      `"build-essential" on Debian/Ubuntu) or set $CC.`
    );
  }
  return cc;
}

// Returns the extra compiler flags needed to find mbedtls, probing a few
// common setups rather than assuming one. Fails loudly with an install hint
// if none work.
function detectMbedtlsFlags(cc) {
  const candidates = [[]]; // plain -lmbedcrypto, assuming default search paths

  try {
    const prefix = execFileSync('brew', ['--prefix', 'mbedtls'], { encoding: 'utf8' }).trim();
    if (prefix) candidates.push([`-I${prefix}/include`, `-L${prefix}/lib`]);
  } catch {
    // no Homebrew / no mbedtls formula installed -- fine, other candidates may still work
  }

  const probeSrc = '#include <mbedtls/aes.h>\n#include <mbedtls/sha1.h>\nint main(void){return 0;}\n';
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-oracle-probe-'));
  const probeFile = path.join(probeDir, 'probe.c');
  const probeOut = path.join(probeDir, 'probe');
  fs.writeFileSync(probeFile, probeSrc);

  for (const flags of candidates) {
    try {
      execFileSync(cc, [...flags, probeFile, '-lmbedcrypto', '-o', probeOut], { stdio: 'ignore' });
      fs.rmSync(probeDir, { recursive: true, force: true });
      return flags;
    } catch {
      // try next candidate
    }
  }

  fs.rmSync(probeDir, { recursive: true, force: true });
  usageAndExit(
    'mbedtls (aes.h/sha1.h + libmbedcrypto) not found. Install it -- e.g. `brew install mbedtls` on macOS, ' +
    '`apt install libmbedtls-dev` on Debian/Ubuntu -- then re-run.'
  );
}

function compileHarness(oracleDir, cc, mbedtlsFlags) {
  const shimDir = path.join(__dirname, 'vmp-oracle');
  const harnessMain = path.join(shimDir, 'harness_main.c');
  const vmpResignC = path.join(oracleDir, 'source', 'vmp_resign.c');
  if (!fs.existsSync(vmpResignC)) {
    usageAndExit(`--oracle does not look like an apollo-psp checkout -- missing ${vmpResignC}`);
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-oracle-build-'));
  const outBin = path.join(outDir, 'vmp_resign_harness');

  try {
    execFileSync(cc, [
      `-I${shimDir}`,
      `-I${path.join(oracleDir, 'include')}`,
      ...mbedtlsFlags,
      harnessMain,
      vmpResignC,
      '-lmbedcrypto',
      '-o', outBin,
    ], { stdio: 'inherit' });
  } catch (err) {
    usageAndExit(`failed to compile the oracle harness against ${oracleDir}: ${err.message}`);
  }

  return outBin;
}

async function main() {
  const { oracle, gme } = parseArgs(process.argv.slice(2));
  if (!oracle) usageAndExit('--oracle <path-to-apollo-psp-checkout> is required');
  if (!gme) usageAndExit('--gme <path-to-.gme-file> is required');

  if (!fs.existsSync(oracle) || !fs.statSync(oracle).isDirectory()) {
    usageAndExit(`--oracle path is not a directory: ${oracle}`);
  }
  requireFile(gme, '--gme file');

  const cc = detectCompiler();
  const mbedtlsFlags = detectMbedtlsFlags(cc);
  const harnessBin = compileHarness(path.resolve(oracle), cc, mbedtlsFlags);

  const saveDir = path.join(__dirname, '..', 'save');
  const { stripGmeHeader } = await import(path.join(saveDir, 'gme.js'));
  const { buildVmp } = await import(path.join(saveDir, 'vmp.js'));

  const gmeBytes = new Uint8Array(fs.readFileSync(gme));
  const mcr = stripGmeHeader(gmeBytes);
  const ourVmp = await buildVmp(mcr);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-oracle-run-'));
  const candidatePath = path.join(workDir, 'candidate.vmp');
  fs.writeFileSync(candidatePath, Buffer.from(ourVmp));

  try {
    execFileSync(harnessBin, [candidatePath], { stdio: 'inherit' });
  } catch (err) {
    console.error(`oracle harness failed to run against ${candidatePath}: ${err.message}`);
    process.exit(1);
  }

  const resigned = new Uint8Array(fs.readFileSync(candidatePath));
  fs.rmSync(workDir, { recursive: true, force: true });

  if (resigned.length !== ourVmp.length) {
    console.error(
      `MISMATCH: oracle output length ${resigned.length} != our output length ${ourVmp.length}`
    );
    process.exit(1);
  }

  let firstDiff = -1;
  for (let i = 0; i < ourVmp.length; i++) {
    if (ourVmp[i] !== resigned[i]) { firstDiff = i; break; }
  }

  if (firstDiff === -1) {
    console.log(`PASS: our buildVmp() output matches the real vmp_resign.c oracle byte-for-byte (${ourVmp.length} bytes).`);
    console.log(`  input: ${gme}`);
    console.log(`  oracle: ${oracle}`);
    process.exit(0);
  }

  const start = Math.max(0, firstDiff - 4);
  const end = Math.min(ourVmp.length, firstDiff + 12);
  console.error(`MISMATCH at byte offset 0x${firstDiff.toString(16)}:`);
  console.error(`  ours:   ...${hex(ourVmp.subarray(start, end))}...`);
  console.error(`  oracle: ...${hex(resigned.subarray(start, end))}...`);
  process.exit(1);
}

main();
