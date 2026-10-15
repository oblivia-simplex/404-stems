// Builders for synthetic SP-404MKII projects: PADCONF.BIN, .SMP samples, pattern and chain files.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const PAD_COUNT = 160;
const HEADER_SIZE = 0xa0;
const RECORD_SIZE = 0xac;
const NAME_SIZE = 24;
const EXTRA_SIZE = 0x80;
export const PADCONF_SIZE = HEADER_SIZE + PAD_COUNT * (RECORD_SIZE + NAME_SIZE + EXTRA_SIZE);
export const SMP_HEADER = 0x200;

export function tempDir(prefix = "sp404-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Pad words, by index (see docs/sp404mk2-project-format.md).
export const W = {
  length: 0, start: 1, end: 2, volume: 3, gate: 4, loop: 5, muteGroup: 7, bpmSync: 8, bpm: 9,
  mode: 10, loopStart: 11, pitch: 13, fine: 14, reverse: 15, speed: 16, pan: 18, attack: 22, hold: 23, release: 24,
} as const;

const EMPTY_WORDS: Record<number, number> = { 3: 0x7f, 4: 1, 6: 1, 9: 9000, 16: 10000, 17: 1, 18: 0x40, 20: 1, 21: 2, 23: 100 };

export interface PadSpec {
  pad: number;
  name?: string;
  frames: number; // sample length, for start/end defaults
  channels?: number;
  words?: Partial<Record<number, number>>; // overrides, by word index
}

export interface PadConfSpec {
  name?: string;
  bpm?: number;
  useProjectTempo?: boolean;
  bankBpm?: number[]; // 10 values
  pads?: PadSpec[];
}

/** Words for a pad that plays its whole sample once, at full volume, centred, in VINYL mode. */
export function padWords(frames: number, channels = 2): Record<number, number> {
  const bytes = frames * 2 * channels;
  return {
    ...EMPTY_WORDS,
    [W.length]: bytes, [W.start]: SMP_HEADER, [W.end]: SMP_HEADER + bytes, [W.loopStart]: SMP_HEADER,
    [W.volume]: 127, [W.gate]: 0, [W.bpm]: 12000, [W.mode]: 1, [W.speed]: 10000, [W.pan]: 64, [W.hold]: 100,
  };
}

export function makePadConf(spec: PadConfSpec = {}): Buffer {
  const buf = Buffer.alloc(PADCONF_SIZE);
  buf.write("RFPD", 0, "latin1");
  const bpm = spec.bpm ?? 120;
  buf.writeUInt32BE(Math.round(bpm * 100) | (spec.useProjectTempo === false ? 0 : 0x10000), 0x10);
  const banks = spec.bankBpm ?? new Array(10).fill(bpm);
  banks.forEach((b, i) => buf.writeUInt32BE(Math.round(b * 100) << 1, 0x40 + i * 4));
  buf.write((spec.name ?? "TEST PROJECT").padEnd(31, " "), 0x80, "latin1");
  const namesAt = HEADER_SIZE + PAD_COUNT * RECORD_SIZE;
  const extraAt = namesAt + PAD_COUNT * NAME_SIZE;
  const byPad = new Map((spec.pads ?? []).map((p) => [p.pad, p]));
  for (let i = 0; i < PAD_COUNT; i++) {
    const p = byPad.get(i);
    const words = p ? { ...padWords(p.frames, p.channels), ...p.words } : EMPTY_WORDS;
    for (let k = 0; k < RECORD_SIZE / 4; k++) buf.writeInt32BE(words[k] ?? 0, HEADER_SIZE + i * RECORD_SIZE + k * 4);
    buf.write((p?.name ?? "").padEnd(NAME_SIZE - 1, " "), namesAt + i * NAME_SIZE, "latin1");
    buf.fill(0xff, extraAt + i * EXTRA_SIZE, extraAt + i * EXTRA_SIZE + EXTRA_SIZE / 2);
  }
  return buf;
}

/** An .SMP file from float channel data in [-1, 1]. */
export function makeSmp(left: ArrayLike<number>, right?: ArrayLike<number>, rate = 48000): Buffer {
  const channels = right ? 2 : 1;
  const frames = left.length;
  const buf = Buffer.alloc(SMP_HEADER + frames * 2 * channels);
  buf.write("RFWV", 0, "latin1");
  buf.writeUInt32BE(buf.length, 4);
  buf.writeUInt32BE(rate, 8);
  buf.writeUInt32BE(channels, 12);
  buf.writeUInt32BE(16, 16);
  const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
  for (let i = 0, o = SMP_HEADER; i < frames; i++) {
    buf.writeInt16BE(q(left[i]), o);
    o += 2;
    if (right) {
      buf.writeInt16BE(q(right[i]), o);
      o += 2;
    }
  }
  return buf;
}

/** A constant-level sample, handy for checking where and how loud hits land. */
export const dc = (frames: number, level = 0.5) => new Float32Array(frames).fill(level);

export interface NoteSpec {
  tick: number;
  pad: number;
  velocity?: number;
  length?: number; // ticks
  note?: number; // chromatic offset in semitones (0 = none)
}

export const METER_CODES: Record<string, number> = { "4/4": 0, "3/4": 1, "5/4": 4 };

/** A pattern file: 8-byte records (delta to next record, pad, flags, note, velocity, 0x40, length), end marker, footer. */
export function makePattern(notes: NoteSpec[], bars = 1, meter = "4/4", opts: { trailingTicks?: number } = {}): Buffer {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const records: number[][] = [];
  let tick = 0;
  const filler = (delta: number) => records.push([delta, 0x80, 0, 0, 0, 0, 0, 0]);
  const advance = (to: number) => {
    // The last record written carries the delta to whatever comes next.
    let gap = to - tick;
    if (gap <= 0) return;
    const last = records[records.length - 1];
    if (last) {
      const d = Math.min(255 - last[0], gap);
      last[0] += d;
      gap -= d;
    }
    while (gap > 0) {
      const d = Math.min(255, gap);
      filler(d);
      gap -= d;
    }
    tick = to;
  };
  for (const n of sorted) {
    if (n.note !== undefined && (n.note < -11 || n.note > 12)) throw new Error(`note ${n.note} can't be stored (-11..12)`);
    advance(n.tick);
    const len = n.length ?? 240;
    records.push([0, 0x2f + (n.pad % 80), 0x40 | (n.pad >= 80 ? 1 : 0), n.note ? n.note + 12 : 0, n.velocity ?? 127, 0x40, len & 0xff, len >> 8]);
  }
  const [beats, unit] = meter.split("/").map(Number);
  const barTicks = (480 * 4 * beats) / unit;
  advance(bars * barTicks + (opts.trailingTicks ?? 0));
  records.push([0, 0x8c, 0, 0, 0, 0, 0, 0]);
  const footer = [bars, 0, 0, 0, METER_CODES[meter] ?? 0, 0, 0, 0];
  return Buffer.from([...records.flat(), ...footer]);
}

export function makeChain(patterns: number[], repeat = false): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<PATTERNCHAIN>`,
    ...patterns.map((n) => `  <PTN NUMBER="${n - 1}"/>`),
    `  <REPEAT VALUE="${repeat ? "On" : "Off"}"/>`,
    `  <CURRENT VALUE="0"/>`,
    `</PATTERNCHAIN>`,
  ].join("\n");
}

export interface ProjectSpec extends PadConfSpec {
  samples?: { pad: number; left: ArrayLike<number>; right?: ArrayLike<number>; words?: Partial<Record<number, number>>; name?: string }[];
  patterns?: { number: number; notes: NoteSpec[]; bars?: number; meter?: string; trailingTicks?: number }[];
  chains?: { number: number; patterns: number[]; repeat?: boolean }[];
  extraFiles?: Record<string, Buffer | string>;
}

export const smpName = (pad: number) => `BANK${Math.floor(pad / 16) + 1}-${String((pad % 16) + 1).padStart(2, "0")}.SMP`;

/** Write a whole project folder and return its path. */
export function writeProject(dir: string, spec: ProjectSpec): string {
  fs.mkdirSync(path.join(dir, "SMPL"), { recursive: true });
  fs.mkdirSync(path.join(dir, "PTN"), { recursive: true });
  const pads: PadSpec[] = (spec.samples ?? []).map((s) => ({ pad: s.pad, frames: s.left.length, channels: s.right ? 2 : 1, words: s.words, name: s.name }));
  fs.writeFileSync(path.join(dir, "PADCONF.BIN"), makePadConf({ ...spec, pads: [...pads, ...(spec.pads ?? [])] }));
  for (const s of spec.samples ?? []) fs.writeFileSync(path.join(dir, "SMPL", smpName(s.pad)), makeSmp(s.left, s.right));
  for (const p of spec.patterns ?? []) {
    fs.writeFileSync(path.join(dir, "PTN", `PTN${String(p.number).padStart(5, "0")}.BIN`), makePattern(p.notes, p.bars ?? 1, p.meter ?? "4/4", p));
  }
  for (const c of spec.chains ?? []) {
    fs.writeFileSync(path.join(dir, "PTN", `PATTERNCHAIN_${String(c.number).padStart(2, "0")}.CHN`), makeChain(c.patterns, c.repeat));
  }
  for (const [rel, data] of Object.entries(spec.extraFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  return dir;
}

/** Frames per pattern tick at a tempo, at the renderer's 48 kHz output rate. */
export const framesPerTick = (bpm: number) => (48000 * 60) / (bpm * 480);
