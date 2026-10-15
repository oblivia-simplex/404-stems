# SP-404MKII project file format (reverse-engineered)

Sources: exported projects (`PROJECTS/Pn_NAME/`) and firmware v5.52 `SP404MKII_APP1.bin`
(plaintext Thumb-2, Cortex-M7 / i.MX RT1060, load base `0x67FA4000`). `APP0.bin` is encrypted.
All multi-byte integers are **big-endian** unless noted.

## Layout

```
Pn_NAME/
  PADCONF.BIN            pad parameters + sample names
  SMPL/BANKb-pp.SMP      b = 1..10 (A..J), pp = 01..16
  PTN/PTNnnnnn.BIN       nnnnn = 1..160 (bank*16 + pad + 1)
  PTN/PATTERNCHAIN_nn.CHN  XML
  PICTURE/
```

On the card itself the firmware uses `ROLAND/SP-404MKII/PROJECT_%02d/{SMPL,PTN,PICTURE}`.

## `.SMP` (magic `RFWV`), confirmed in firmware (writer at `0x6808C648`)

| off   | size | meaning |
|-------|------|---------|
| 0x00  | 4    | `RFWV` |
| 0x04  | 4    | file size − 8 |
| 0x08  | 4    | sample rate (48000) |
| 0x0C  | 4    | channels |
| 0x10  | 4    | bits (16) |
| 0x14  | 12   | zero |
| 0x20  | 16   | digest of the four header fields |
| 0x30  | 464  | filler from `srand(0); rand()`. Looks encrypted but is not audio |
| 0x200 | …    | interleaved signed PCM, **big-endian** |

There is no encryption. Swap bytes from offset 0x200 to get WAV data.

## `PTNnnnnn.BIN` (patterns)

8-byte records, then an 8-byte end record and an 8-byte footer.

| byte | meaning |
|------|---------|
| 0 | ticks to the next record (480 PPQN) |
| 1 | pad code. `0x80` = no event (time filler), `0x8C` = end of data |
| 2 | bit0: upper half of banks (+80 pads); bit6: unknown (seen 0x40) |
| 3 | unknown. Small values (6..23) and 0x8D–0x90 seen; possibly a pitch-mode note |
| 4 | velocity |
| 5 | always 0x40 so far |
| 6–7 | note length in ticks, **little-endian** |

Pad index (0..159) = `(byte1 − 0x2F) + 80·(byte2 & 1)`, then bank = idx / 16, pad = idx % 16.
Validated: all 1,096 events in P4 map to existing samples. The firmware also converts SP-404SX
patterns (12 pads/bank) to this layout (`0x67FE0E96`).

Footer (8 bytes): byte 0 = length in bars, byte 4 = time signature (0 = 4/4, 1 = 3/4, 4 = 5/4 seen),
bytes 5–7 mostly `80 nn 01` (byte 6 often equals bars; meaning unknown).
Pattern length = bars × bar length (4/4 = 1920 ticks, 3/4 = 1440, 5/4 = 2400). The record stream can run
past that (83 of 824 patterns have trailing filler) but never has notes beyond it, so the stream total
isn't the length.

## `PATTERNCHAIN_nn.CHN`

```xml
<ROLAND_SP404MKII_PATTERN_CHAIN>
  <REPEAT VALUE="Off"/><CURRENT VALUE="6"/>
  <PTN NUMBER="32"/> ...   <!-- 0-based: file PTN00033.BIN -->
</ROLAND_SP404MKII_PATTERN_CHAIN>
```

## `PADCONF.BIN` (magic `RFPD`)

- Header 0xA0 bytes: "RFPD", 0xA0, 0x03000000, 0x7A80 (written by `FUN_6800bd70`), project name at 0x80.
- **Tempo**: header word 0x10, low 16 bits = project BPM×100 (getter ID 10); bit 16 (ID 0x0B) = tempo mode.
  - bit 16 = 1: every pattern plays at the project tempo (BELLELNI 0x11D4C → 75; confirmed by the user).
  - bit 16 = 0: each pattern plays at the tempo of the bank it's stored in (P4 pattern C2 → bank C = 85).
- Header words 0x40..0x64, one per bank A..J (IDs 0x21–0x2A): bank tempo = value >> 1 (BPM×100).
  Bit 0 (IDs 0x17–0x20) locks editing of that bank's pad settings (`FUN_67fe0538`).
- Header 0x68 (ID 0x2B–0x34): ten bank flags, bit *b* for bank *b* (meaning not confirmed).
- **Bank volume**: header 0x6C–0x7F, ten 16-bit values for banks A–J (IDs 0x35–0x3E; Roland's app: `Project.BankA.Volume`…,
  range 0–127, default 127). Stored as **127 − volume**, so an untouched project stores 0. Each u32 word holds two banks, with
  the even bank in the low half, so it is stored second in the file. Confirmed on the user's unit: project 2 has nine banks
  at 90 (stored 0x25) and bank F at 127 (stored 0), giving `00250025 00250025 00000025 00250025 00250025` at 0x6C. Setting
  one pushes voice parameter 6 to all 16 pads of that bank. The renderer plays a pad at pad volume/127 × bank volume/127,
  and the refactor tool folds a pad's old bank volume into its own volume, since pads change banks.
- Whole-file layout from the serializer (`FUN_6814daf8`): 0x10 head + 0x90 header + 0x6B80 pad
  records + 0xF00 names + 0x5000 (160 × 128, undecoded) = 52,000 bytes.
- 160 pad records × 0xAC bytes at 0xA0 (43 BE u32 words). The firmware serializer (`FUN_6814daf8`)
  copies each in-memory record verbatim and byte-swaps it, and the pad parameter ID for word *n*
  is `0x66 + n` (n ≤ 17). Field meanings marked **FW** come from the SP-404SX importer
  (`FUN_680a8a1e`), which maps documented SX `PAD_INFO.BIN` fields onto these IDs.

| word | off  | meaning | source |
|------|------|---------|--------|
| 0  | 0x00 | sample end / length (byte offset in .SMP) | FW (id 0x66) |
| 1  | 0x04 | start point (byte offset; 0x200 = start of audio) | FW (0x67) |
| 2  | 0x08 | end point (byte offset) | FW (0x68) |
| 3  | 0x0C | volume 0–127 | data |
| 4  | 0x10 | **gate** 0/1 | FW (0x6A ← SX gate) |
| 5  | 0x14 | **loop** (0 / 0x7FFFFFFF) | FW (0x6B ← SX loop) |
| 7  | 0x1C | mute group (0 = off)? Hi-hats F5–F8 share 6 | data |
| 8  | 0x20 | **BPM sync**: the region is time-stretched (pitch kept) by tempo ÷ word 9 | FW (0x6E ← SX tempo mode); BELLELNI H5 |
| 9  | 0x24 | original BPM ×100 | FW (0x6F) |
| 10 | 0x28 | bit 0 = **VINYL mode**: plain resampling at 2^(pitch/12) × SPEED; BPM sync doesn't stretch a VINYL pad, and with sync on SPEED is stale and ignored (user-confirmed, ORANGUTANGO B9). Some saves keep the vinyl rate in SPEED with pitch 0 (A6: 0.8408 = −3 semitones). Bits 1–2 = **VARI mode** when VINYL is off: 0 Off, 1 Backing, 2 Ensemble (firmware `voice_set_param` param 0x70 takes `(v & 7) >> 1` and picks a stretch window of 600/400/800). Roland's app v4.05 names this word `Sample.Polyphonic` (range 0–1), so bit 0's naming is unsettled; polyphony is a chromatic-mode setting. Bits 3–5 unknown | data + v3 manual p.52 + FW |
| 11 | 0x2C | loop start (byte offset) | FW (0x71) |
| 12 | 0x30 | set when loop on | FW (0x72) |
| 13 | 0x34 | signed −12..+12, pitch semitones? | data |
| 14 | 0x38 | signed, fine tune cents? | data |
| 15 | 0x3C | **reverse** (SX import writes 2; 1 seen in data) | FW (0x75 ← SX reverse) |
| 16 | 0x40 | speed ×10000 (playback timing, independent of pitch except in VINYL). On synced pads it holds tempo at save ÷ original BPM (H5: 75/108.28 = 6927) | FW (0x76) |
| 17 | 0x44 | 0/1, unknown | |
| 18 | 0x48 | pan 0–127, 0x40 = centre | data |
| 20 | 0x50 | 0/1/2 (bus?) | |
| 22–24 | 0x58–0x60 | attack / hold(100) / release? | data |

- Sample names: 160 × 24-byte NUL-terminated strings at `0xA0 + 160·0xAC` (0x6C20).
  This is followed by 20,480 more bytes (160 × 128) that are not yet decoded.

## Time-stretch algorithms

The manual (v3, p.52) lists VINYL MODE (Yes/No) and VARI MODE (Off / Backing / Ensemble), the latter "based on
VariPhrase". The DSP doing this isn't readable: APP0 is encrypted apart from a data region (float tables at
0x1F0000–0x238000) and a non-ARM block at 0x140000 that looks like microcode for a custom DSP. The renderer
approximates each mode from its description (src/sp404/stretch.ts).

## Pattern continuation (device setting)

The MK2 has two pattern continuation modes (from the user; not found in the project files yet):
- MK2: sounds still playing from pattern X stop the instant a different pattern Y starts; X repeating itself carries on.
- SX: sounds from X ring on into Y until they finish.
The renderer exposes this as an option (default MK2).

## USB file access (internal storage)

Over USB-C the unit is two devices behind its own hub: a class-compliant audio/MIDI device (`SP-404MKII`) and a
CDC-ACM serial port (`Roland SP-404MKII`, VID `0582`, PID `02E7`; `/dev/cu.usbmodem*` on macOS). Roland's
SP-404MKII app (v4.05, `CEmuFile::RFS*`, `CFileIO::Open`, `SmplCopyDir`) uses the serial port as a remote file
system; its "export project" is a recursive copy through it. Implementation: `src/sp404/remote/`.

**Framing.** Each message is a 12-byte header, then for long frames (header byte 0 bit 0 set) a little-endian u32
length and the payload. Header bytes 0–3 are message id, source, destination and class: the app sends
`13 60 E0 06` for file requests, the unit answers `13 E0 60 06`; bytes 4–11 are unused (the unit leaves pointer
junk there). Short frames carry ≤7 bytes inline at 4–10 with the length at byte 11.

**Session.** The app's keep-alive/connect message is the short frame `12 60 E0 05 FE 67 <mode> 00 00 00 00 03`.
The unit replies with a long frame whose 19-byte payload ends in `0x33` (firmware status; the app ignores replies
without that byte). Serial settings don't matter (the app uses 230400 8N1 raw).

**Requests** (payload): `F0 41 7A 03 <cmd> <a> <b> <tail> F7`, where `a` and `b` are 32-bit values written as five
7-bit groups, most significant first, and `tail` is a path or one extra byte (0 when unused).

| cmd | request | a | b | tail | reply |
|---|---|---|---|---|---|
| `00` | open | mode (0 = read) | path length incl. NUL | path + NUL | result: fd, or -1 |
| `03` | close | fd | 0 | 0 | result |
| `04` | read | fd | byte count (≤ 0x55000; app sets 0x20 in the top group above 1 KB) | 0 | data packets; result 0 at EOF |
| `06` | write | fd | … | data | result (not used by this tool) |
| `07` | seek | fd | offset | whence | result: new position |
| `0A` | remove | 0 | path length incl. NUL | path + NUL | result (not used by this tool) |
| `0C` | opendir | 0 | path length | path, no NUL | result: handle (a device pointer, negative as int32), 0 = error |
| `0D` | closedir | handle | 0 | 0 | result |
| `0E` | readdir | handle | 0 | 0 | one data packet per entry; result -1 at the end |
| `13` | fstat | fd | 0 | 0 | data: u32 mode, u32 size (little-endian) |

**Replies**: `F0 41 7A 7A <value> <errno> F7` (result, two 7-bit-group values); `F0 41 7A 02 <5 bytes> <length> <data> F7`
(data packet: bit 6 of the length's first byte marks the last packet); `F0 41 7A 7C F7` (busy: the app extends its
2.5 s time-out to 10 s). Directory entries are 4 bytes, name length, type (4 = folder, 8 = file), then the name.

**Paths** are `/SP404REMOTE//` followed by an absolute path (so three slashes in a row); a trailing slash fails.
The root holds `FCTRY/`, `ROLAND/` and `DOOMBOOT.DAT`. Projects are `/ROLAND/SP-404MKII/PROJECT_01` … `PROJECT_16`,
each with `PADCONF.BIN`, `SMPL/`, `PTN/` and `PICTURE/` in the same format as an SD-card export. Reads run at about
4.7 MB/s.
