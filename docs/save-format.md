# PS1 Save Format Reference (MCR / GME / VMP)

A byte-level reference for converting PS1 memory card saves between PC
emulator formats (raw MCR, DexDrive GME) and the PSP/Vita POPS format (VMP).
Derived from bucanero/apollo-psp (`ps1card.c`, `vmp_resign.c`) and
dots-tb/vita-mcr2vmp, cross-checked against real DexDrive `.gme` files and
real DuckStation-produced `.mcd` memory cards.

---

## 1. High-Level Overview

```
GME (DexDrive, PC emulator)  <---+
                                  |
                                  v
                          raw MCR (128KB)  <---> DuckStation/ePSXe/etc. directly
                                  |
                                  v
                    VMP (PSP/Vita POPS format)
```

A raw memory card is the common currency: GME is just a raw card with a
cosmetic header prepended, and VMP is a raw card with a small header plus a
cryptographic signature. Converting between any two formats means unwrapping
down to the raw card, then wrapping it back up in the target format.

---

## 2. Raw PS1 Memory Card (MCR)

131072 bytes (128KB) total: 16 blocks of 8192 bytes each.

- **Block 0** is the directory block: sixty-four 128-byte frames.
  - Frame 0: the card's own ID/signature frame (`"MC"` at offset 0, an XOR
    checksum at offset 127) — **not a save slot**.
  - Frames 1–15: one directory frame per save slot (15 slots total).
  - Frames 16–62: reserved; not read or written by this project. (A real
    card fills these with `0xFF`-marked "unused" placeholder data, per
    `ps1card.c`'s own from-scratch card builder, but nothing here is needed
    to parse or produce a working save.)
  - Frame 63: a second copy of the `"MC"` signature + XOR checksum,
    mirroring frame 0 (confirmed in `ps1card.c`'s `loadDataToRawCard`,
    which writes the same `"MC"` + checksum at both byte 0 and byte 8064).
- **Blocks 1–15** are the corresponding 8192-byte save-data blocks.

**The off-by-one is easy to miss:** slot *i*'s directory frame lives at byte
offset `128 * (i + 1)`, not `128 * i` — frame 0 is the card ID frame, not
slot 0. Same shift for data blocks: slot *i*'s data is block `i + 1`, not
block `i`. This project's `save/mcr.js` got this wrong on the first pass
(indexing the directory block directly by slot number starting at 0,
which reads frame *i* instead of frame *i+1* for slot *i*) — caught by
re-reading `ps1card.c`'s `loadDataFromRawCard()` directly against real card
bytes while building single-save isolation, not by the earlier tests, whose
synthetic fixtures and casual real-file spot checks didn't happen to expose
the shift.

### Directory frame layout (128 bytes)

| Offset | Size | Field                                                       |
|--------|------|--------------------------------------------------------------|
| 0x00   | 1    | Block state (see table below)                                |
| 0x04   | 3    | Save size in bytes, little-endian (meaningful on the *initial* frame only) |
| 0x08   | 1    | Next-slot link — index of the next frame in a multi-block save's chain, or `0xFF` for end-of-chain |
| 0x0A   | 20   | Filename field, itself: 2-byte region + 10-byte product code + 8-byte identifier |
| 0x7F   | 1    | XOR checksum of the first 126 bytes (not verified by this project) |

### Block state values

| Byte   | Meaning              |
|--------|----------------------|
| 0xA0   | Formatted (empty)    |
| 0x51   | Initial (head of an active save's chain) |
| 0x52   | Middle-link          |
| 0x53   | End-link             |
| 0xA1   | Deleted-initial       |
| 0xA2   | Deleted-middle-link   |
| 0xA3   | Deleted-end-link      |
| other  | Corrupted            |

Deletion is a **soft delete**: only the state byte flips (e.g. `0x51`↔`0xA1`)
— the underlying 8KB data block is untouched, so a deleted save is fully
recoverable until another save overwrites that slot.

### Multi-block chains

A save larger than one 8KB block spans multiple slots, linked via each
frame's next-slot byte (offset 0x08): `initial` → `middle-link`(s) →
`end-link`, terminated by a `0xFF` sentinel. Only the *initial* frame's size
field is meaningful; continuation frames' size fields are unused. Walking
this chain (`findSaveLinks` in `save/mcr.js`) mirrors apollo-psp's own
`findSaveLinks()`, including its defensive bounds check against a
corrupted/out-of-range link byte and a hard cap at 15 iterations against a
cyclic chain.

### Isolating a single save (`extractSaveMcr`)

To hand a single save to another tool (e.g. exporting one save from a VMP
to a PC emulator, or one save from a PC card to a VMP), build a fresh 128KB
card containing just that save's chain, with every other slot blanked
exactly like apollo-psp's `formatSlot()`: state byte `0xA0`, next-link byte
`0xFF`, everything else zero. The card ID frame and the directory block's
reserved frames are preserved verbatim.

---

## 3. GME (DexDrive) Container

134976 bytes total: a 3904-byte header, followed by the verbatim
131072-byte raw card.

| Offset       | Size | Field                                            |
|--------------|------|----------------------------------------------------|
| 0x000        | 11   | Magic `"123-456-STD"`                              |
| 0x012        | 1    | `0x01` (always, meaning undocumented upstream)     |
| 0x014        | 1    | `0x01` (always, meaning undocumented upstream)     |
| 0x015        | 1    | `0x4D` (`'M'`, always, meaning undocumented upstream) |
| 0x016 + *i*  | 1    | Slot *i*'s block-state byte, copied verbatim from its directory frame (15 bytes, one per slot) |
| 0x026 + *i*  | 1    | Slot *i*'s next-slot link byte, copied verbatim (15 bytes) |
| 0x040 + 256·*i* | 256 | Slot *i*'s free-text comment (DexDrive-family tools show this as a save description; not derivable from the raw card, and commonly blank — this project always leaves it zeroed) |
| 0xF40        | —    | End of header (3904 bytes); raw card follows       |

Verified byte-for-byte against a real DexDrive-produced `.gme`
(`chrono-cross.4587.gme`): `wrapGme(stripGmeHeader(real))` reproduces that
file exactly, header included, comment fields and all.

---

## 4. VMP (PSP/Vita POPS) Container

131200 bytes (`0x20080`) total: a 128-byte header, the verbatim 131072-byte
raw card at offset `0x80`, and a 20-byte SHA-1 signature embedded within
the header.

| Offset | Size | Field                                                        |
|--------|------|----------------------------------------------------------------|
| 0x00   | 1    | `0x00`                                                          |
| 0x01   | 3    | `"PMV"` — together with byte 0, this is the magic `0x564D5000` read as a little-endian uint32 at offset 0 |
| 0x04   | 1    | `0x80` — a header-length marker, easy to miss since only the 4-byte magic is checked when *re-signing* an existing file; this byte is only written when building a VMP from scratch (`ps1card.c`'s `setVmpCardHeader`) |
| 0x0C   | 20   | Seed — always overwritten with the fixed string `"www.bucanero.com.ar\0"` as a side effect of signing |
| 0x20   | 20   | SHA-1 signature (see below)                                     |
| 0x80   | 131072 | Raw memory card, verbatim                                     |

### Signing scheme (`generateHash`)

The signature is an HMAC-SHA1-like construction over the whole file, using a
fixed (public, non-secret — embedded in GPL source) AES-128 key and IV:

1. Build a 64-byte "salt": AES-128-ECB-decrypt the first 16 bytes of the seed
   string with the fixed key into `salt[0:16]`, AES-128-ECB-*encrypt* the
   same 16 bytes with the same key into `salt[16:32]`. XOR `salt[0:16]` with
   the fixed 16-byte IV. XOR `salt[16:32]` with a second 16-byte buffer built
   from seed bytes 16–19 followed by twelve `0xFF` bytes. Then zero
   `salt[20:64]` — note this **discards bytes 4–15 of the encrypt result**
   (and its XOR) computed a moment earlier; only its first 4 bytes
   (`salt[16:20]`) survive into the final salt. This looks like wasted work,
   but it's exactly what the reference implementation does, so the port
   preserves it rather than "optimizing" it away.
2. XOR the salt with the byte `0x36` (the HMAC "ipad" constant), then
   SHA-1(salt ‖ file), producing a 20-byte inner hash.
3. XOR the *same* salt buffer with `0x6A` — **not** `0x6A ^ 0x36` — applied
   directly to the already-`0x36`-XORed buffer (this is where a naive
   from-scratch port gets the algebra wrong; it must mirror the C code's
   literal sequential `XorWithByte` calls on the same mutating buffer, not a
   textbook HMAC "outer key = key XOR opad" derivation from the *original*
   key).
4. SHA-1(salt ‖ inner hash) is the final 20-byte signature, written at
   offset `0x20`.

Verified byte-exact against 6 golden vectors independently derived from a
local C harness compiled against `mbedtls`, replicating `vmp_resign.c`'s
actual `generateHash()` — not a re-derivation of our own understanding of
the algorithm. A dedicated, parameterized oracle script
(`scripts/verify-vmp-oracle.cjs`) compiles and runs apollo-psp's real,
unmodified `vmp_resign.c` against this project's own `buildVmp()` output for
independent verification on demand.

### Why AES-128-ECB needed a clean-room implementation

The browser's Web Crypto (`SubtleCrypto`) API has no ECB mode — it's
deliberately omitted because ECB leaks patterns across multi-block messages.
AES-CBC with a zero IV is mathematically equivalent to ECB for a single
block, but `SubtleCrypto`'s CBC always adds PKCS7 padding with no way to
disable it, so it can't produce a clean 16-byte-in/16-byte-out result either.
`save/aes-ecb.js` is a from-scratch FIPS-197 implementation of just the
single-block primitive this format needs — verified against the FIPS-197
Appendix B known-answer test vectors.

---

## Sources

- **bucanero/apollo-psp**: https://github.com/bucanero/apollo-psp
  - `source/ps1card.c` — MCR directory-frame layout (`loadDataFromRawCard`,
    `loadSlotTypes`, `loadStringData`, `loadSaveSize`, `findSaveLinks`,
    `formatSlot`), GME header construction (`fillGmeHeader`), VMP header
    construction (`setVmpCardHeader`). Itself credits Shendo's MemcardRex
    (https://github.com/ShendoXT/memcardrex) as the basis for its memory
    card handling.
  - `source/vmp_resign.c` — VMP/PSV signing scheme (`generateHash`), based
    on dots-tb/vita-mcr2vmp. The fixed AES key/IV constants live here.
- **dots-tb/vita-mcr2vmp**: https://github.com/dots-tb/vita-mcr2vmp
  - Original VMP signing implementation that `vmp_resign.c` is based on.
