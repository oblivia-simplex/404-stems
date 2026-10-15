# SP-404MKII firmware notes (APP1 v5.52)

Our own description of what the decompiled firmware shows, written to guide the renderer and the format docs. Function
names refer to `names.tsv`. The decompile itself (`decompiled/`, gitignored) is Roland's code and stays local; see
`tools/README.md` to rebuild it.

Confidence: **high** = read directly from code or tables and consistent with data; **medium** = strong inference,
not traced end to end; **low** = a guess worth testing.

## Image and memory map

- `SP404MKII_APP1.bin` is plaintext Thumb-2 for the i.MX RT1060 (Cortex-M7), loaded at `0x67FA4000`. Code runs up
  to about `0x6818_0000`; past that come tables, fonts and images. "Functions" Ghidra reports there come from
  prologue-looking bytes in data and can be ignored.
- **File offsets `0x1F0000`..end are also copied to RAM** at `file offset + 0x7FFDE540` (for example 0x25EA3E →
  0x8023CF7E). Most UI strings and many tables are used through that RAM copy, so a string with no references at
  its flash address is normal. The base comes from 561 constants that land exactly on string starts; no other base
  comes close. `MapData.java` maps the block so the decompile shows those strings.
- `APP0.bin` is encrypted (except a float-table region and what looks like DSP microcode). The per-sample audio work
  (mixing, gain curves, envelope evaluation, time-stretch) is not in readable APP1 code. APP1 prepares parameters
  and hands them to the engine.
- Globals: current project struct `0x82E2CD08` (`prj_get_current`); sample engine `0x80591800`
  (`engine_set_pad_param`); system settings object `0x80591ADC` (`sys_get`); parameter dispatcher `0x82E009D0`
  (`prm_get`, `prm_set`); per-voice DSP blocks at `0x2023F000 + n×0x328`.

## Project struct (in memory) ↔ PADCONF.BIN

Header: **memory offset = file offset + 0x18** (`padconf_load` reads words in order; `padconf_serialize` writes them
byte-swapped).

| mem | file | IDs | meaning |
|---|---|---|---|
| 0x28 | 0x10 | 10, 0x0B | low 16 bits project BPM×100; bit 16 = use project tempo |
| 0x2C..0x54 | 0x14..0x3C | 0x0C..0x16 | Effect Routing, Bus FX Assign, FX Prm4–6, Effect Limit, Direct FX1–5 |
| 0x58..0x7C | 0x40..0x64 | 0x17..0x20 / 0x21..0x2A | per bank: bit 0 = protect; bits 1–16 = tempo×100 |
| 0x80 | 0x68 | 0x2B..0x34 | bit *b* = "Bank Ptn Protect" for bank *b* |
| 0x84..0x96 | 0x6C..0x7F | 0x35..0x3E | BANK VOLUME, u16 per bank (stored 127 − level; even bank in the low half) |
| 0x98 | 0x80 | | project name |

Pads: record *p* at mem `0xD0 + p×0xAC`, word *n* at `+4n`, same layout as the file records. Getter/engine
parameter ID = `0x66 + n` for words 0–21. The envelope words don't follow that pattern: word 22 → 0x7D, 23 → 0x7E,
24 → 0x7F, 25 → 0x7C. (In `prj_set_param` the decompiler's case labels are 2 lower than the IDs.)

| word | ID | label (`prm_name`) | values (`prm_value_text`, Roland app) |
|---|---|---|---|
| 0 | 0x66 | LENGTH | sample end, bytes |
| 1/2 | 0x67/0x68 | START / END POINT | bytes |
| 3 | 0x69 | VOLUME | 0–127 |
| 4 | 0x6A | GATE | on/off |
| 5 | 0x6B | LOOP | on/off |
| 6 | 0x6C | BUS Effect Asgn | ON/OFF (1 on every pad seen) |
| 7 | 0x6D | MUTE GROUP | 0 = off, 1..10 |
| 8 | 0x6E | TEMPO SYNC | on/off |
| 9 | 0x6F | ORIGINAL BPM | ×100 |
| 10 | 0x70 | "Polyphonic" word, a **bit field**: bit 0 Fixed Velocity (0xF5), bits 1–2 time-stretch type (0xF6: Off, Backing, Ensemble, "TBD2"), bits 3–4 unknown (0xF3), bit 5 One Shot (0x100) | |
| 11 | 0x71 | loop start | bytes |
| 12 | 0x72 | TOP | ON/OFF (loop start in use) |
| 13 | 0x73 | PITCH | semitones |
| 14 | 0x74 | FINE | cents |
| 15 | 0x75 | PLAY | 0 Normal-A, 1 Reverse-A, 2 Normal-B, 3 Reverse-B (app 4.05: Forward, Reverse, Fwd Ping-Pong, Rev Ping-Pong) |
| 16 | 0x76 | SPEED | %×100; shown as "SYNC" when TEMPO SYNC is on |
| **17** | **0x77** | **VINYL** | **No / Yes** |
| 18 | 0x78 | PAN | 64 = C, 64±50 = L50..R50, 13/115 = MONO(L)/MONO(R) |
| 19 | 0x79 | PAD LINK | 0 = off, else link group |
| 20 | 0x7A | BUS FX Assign | DRY, BUS n |
| 21 | 0x7B | Roll | Off, 1/2..1/64, 3/8..3/64 (2 on every pad seen) |
| 22/23/24 | 0x7D/0x7E/0x7F | Attack / Hold / Release | 0–127 / 1–100 % / 0–127 |
| 25 | 0x7C | unknown | 0/1 (7 pads) |

The per-pad 128-byte block after the names holds 16 marks (IDs 0x8E..0x9D at +0x00..+0x3C), then IDs 0x89 (+0x40),
0x8A..0x8C (+0x44..+0x4C) and 0x8D (+0x50). IDs 0x8A–0x8C drive a BPM-synced modulation set up at note-on: a
beat-division mode (1–4 and 5–8 use different divisions), a depth ((value + 8) × 0.05), and phase points at ¼, ½
and ¾ of the period. Only a few of the user's pads set 0x8A.

## Voice (CSmplCharge) fields

`smplcharge_init` (0x67FE8CB8) is the note-on; `voice_set_param` (0x68068758) applies live changes. Voice word
index → source: `[0x2A]` pad volume×100 (param 0x69), `[0x2B]` stored bank attenuation×100 (prm 0x35 + bank, param
6), `[0xC]`/`[0xD]` sync / original BPM, `[0x34]` TOP, `[0x35]`/`[0x36]` pitch / fine, `[0x37]` PLAY, `[0x39]`
SPEED, `[0x3A]` VINYL, `[0x3B]` pan, `[0x3C]` pad link, `[0x3D]` roll, `[0x3E..0x40]` attack/hold/release,
`[0x4A]` word 10, `[0x57]` stretch type, `[0x58]` pitch ratio (fixed point, 14 fractional bits), envelope
breakpoints at `[0x18..0x28]`.

## Findings for the renderer

1. **VINYL is word 17, not word 10 bit 0. High.** `prm_name` labels ID 0x77 "VINYL", Roland's app shows it as
   No/Yes, and the data agree. Pads with word 17 = 1 keep FINE within −33..+40 cents and PITCH within −7..+8; the
   manual allows ±50 cents in VINYL mode and ±100 otherwise, and word-17 = 0 pads reach ±98. Word 10 bit 0 is
   **Fixed Velocity**. `render.ts isVinyl()` reads `raw[10] & 1`: it treats 238 fixed-velocity pads as VINYL and,
   with the current rule, turns off their BPM sync. It also misses the 2,692 real VINYL pads. ORANGUTANGO B9 (the
   flute) has word 17 = 0, so it is *not* VINYL. On the unit it should play pitch −4 with time kept, stretched to
   tempo (listening-pack file 7, not file 3; they differ only about 4% in length). The "VINYL ignores BPM sync"
   rule was derived from that pad, so it is unproven for real VINYL pads (93 synced VINYL pads in the user's
   projects; 22 synced pads are fixed-velocity pads that currently lose their sync).
2. **Word 10 is a bit field. High.** `prm_get`/`prm_set` 0xF5/0xF6/0xF3/0x100 read and write it with masks. The
   stretch type (bits 1–2) matches the renderer's `variMode`. **One Shot = bit 5**; turning it on clears GATE, LOOP
   and TOP (`prm_set`), and the 10 one-shot pads in the data have neither gate nor loop. The renderer doesn't
   implement one-shot yet.
3. **Envelope formula. High** (`env_setup` 0x68068858): attack and release last `value × 144000 / 127` frames (127 =
   3 s at 48 kHz, linear: the renderer's `envFrames` is right). Hold ends at `start + length × hold / 100`. The
   release *ends* at the hold point. If attack and release overlap, the turning point is `length × A / (A + R)`. The
   renderer multiplies the two ramps instead, which differs only when they overlap.
4. **Envelope runs in sample position. Medium.** `env_setup` receives the region's start and length after the
   voice's position converter, so the breakpoints are positions in the sample, not elapsed output time. If the
   engine compares them with the playhead, pitch and speed scale envelope times (VINYL +12 halves them). The
   renderer counts output frames. Test: a pad with attack 64 at VINYL +12 vs 0.
5. **Release when a held (gated) note is let go. Medium** (`env_release_on_stop`): the fade lasts `R × 144000 / 127`
   frames, counted in 64-frame blocks and capped at what's left of the sample. Under 8,128 frames (R < about 7.2)
   there is no release fade. The renderer uses `max(5 ms, release)`.
6. **Pan. High** (`voice_set_param` 0x78): near side 10000, far side `(50 − |pan − 64|) / 50 × 10000`, no channel
   mixing, which matches the measurement. Pan 13 (MONO L), 115 (MONO R) and 64 all set both gains to 10000, so
   MONO's actual left/right placement happens elsewhere (probably a mono flag in the DSP). The renderer treats 13/115
   as hard L50/R50, which is likely wrong; MONO is not measured.
7. **Pitch. High:** semitones = PITCH + FINE/100, ratio 2^(s/12), stored with 14 fractional bits. Matches.
8. **Levels. High** for the inputs: the voice gets pad volume×100 and the stored bank attenuation×100. The curves are
   applied in the DSP, so the unit measurements (pad and velocity linear, bank squared) remain the reference.
9. **Time-stretch windows. Medium:** stretch type 0 Off → 600, 1 Backing → 400, 2 Ensemble → 800 (units unknown;
   plausibly samples or tenths of a millisecond). Backing has the *shortest* grain and Ensemble the longest, which
   fits "attacky" vs "smooth". `stretch.ts` uses 2048 for Off and 4096 for Ensemble frames; worth scaling the
   relative sizes to 600 : 400 : 800.
10. **SPEED is ignored when synced. High:** the value text shows "SYNC" instead of a percentage.
11. **PLAY / reverse. Medium:** bit 0 = reverse; bit 1 = the "-B" variant (ping-pong per Roland's app 4.05).
    `padconf.ts` treats any non-zero value as reverse, so value 2 (Normal-B, 3 pads) renders backwards; it should
    play forward (ping-pong if B means that).
12. **Pattern continuation is a system setting. Medium-high:** "PTN Change Mode" is system index 0x13F, not project
    data. On a change to a *different* pattern with mode 0, `ptn_select_change` / `ptn_change_queue` call
    `seq_stop_voices` (post_cmd 6 for sources 0 and 0x14); repeating the same pattern doesn't cut. So mode 0 = MK2
    (cut), the renderer's default. Keep it as a render option.
13. "Reverse Type" (system 0x143) changes how a reverse switch is applied while playing; it doesn't matter for
    offline renders.

## Open questions and where to look

- Word 10 bits 3–4 (ID 0xF3): no label found. Look for its setter's UI page (`prm_set` callers passing 0xF3).
- What MONO(L)/MONO(R) does to the audio: find the consumer of voice `[0x3B]` beyond `voice_set_param`, or measure.
- Whether the envelope follows sample position (finding 4): measure.
- VINYL + TEMPO SYNC behaviour on a real VINYL pad (finding 1): measure.
- PAD LINK (word 19, 36 pads use it): do pattern hits on a linked pad also trigger the others? Look at the pad-hit
  path near `bank_sync_gate_toggle` and the "PAD LINK GROUPS" page (0x680BBE48).
- Fixed Velocity (word 10 bit 0): whether playback overrides the recorded velocity. Look for `prm_get(0xF5)` callers.
- Word 25 (ID 0x7C, 7 pads) and per-pad IDs 0x89/0x8D: unknown.
- Pattern byte 3, the byte 2 0x40 flag and footer bytes 5–7 were not traced: the live sequencer works on RAM
  structures loaded from PTN files; `ptn_file_copy` (0x67FD22E8) is the file-side walker to start from.
- Swing/shuffle ("SHFL RATE", "SHFL RESO" in `ptn_settings_labels`) and the per-pattern settings storage.
