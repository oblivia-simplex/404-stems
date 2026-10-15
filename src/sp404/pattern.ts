import * as fs from "fs";

// PTNnnnnn.BIN: 8-byte event records at 480 PPQN. See docs/sp404mk2-project-format.md.
export const PPQN = 480;
export const TICKS_PER_BAR = PPQN * 4;
const PAD_NONE = 0x80;
const END_OF_DATA = 0x8c;
const PAD_BASE = 0x2f;

// Footer byte 4 → [beats per bar, beat unit]. Codes seen in real projects; others are inferred.
const METERS: Record<number, [number, number]> = { 0: [4, 4], 1: [3, 4], 4: [5, 4] };

export interface PatternEvent {
  tick: number;
  pad: number; // 0..159
  velocity: number; // 0..127
  length: number; // ticks
  note: number; // semitone offset from chromatic play, 0 when not played chromatically
  raw: number[];
}

export interface Pattern {
  number: number; // 1..160, as in the file name
  label: string; // e.g. "C2"
  bars: number;
  ticks: number;
  // Meter, from footer byte 4 (see METERS).
  beatsPerBar: number;
  beatUnit: number; // 4 = quarter-note beats, 8 = eighth-note beats
  events: PatternEvent[];
}

export interface Chain {
  number: number;
  repeat: boolean;
  patterns: number[]; // pattern numbers (1-based, matching PTN file names)
}

export function patternLabel(number: number): string {
  const i = number - 1;
  return `${"ABCDEFGHIJ"[Math.floor(i / 16)]}${(i % 16) + 1}`;
}

export function readPattern(file: string, number: number): Pattern {
  const buf = fs.readFileSync(file);
  const events: PatternEvent[] = [];
  let tick = 0;
  for (let o = 0; o + 8 <= buf.length - 8; o += 8) {
    const r = [...buf.subarray(o, o + 8)];
    if (r[1] === END_OF_DATA) break;
    if (r[1] !== PAD_NONE) {
      // Byte 3: chromatic note, 12 = unshifted. Values with bit 7 set are not understood yet; treat as unshifted.
      const note = r[3] === 0 || r[3] & 0x80 ? 0 : r[3] - 12;
      events.push({
        tick,
        pad: r[1] - PAD_BASE + 80 * (r[2] & 1),
        velocity: r[4],
        length: r[6] | (r[7] << 8),
        note,
        raw: r,
      });
    }
    tick += r[0];
  }
  const bars = buf[buf.length - 8] || 1;
  // Footer byte 4 is the time signature. The record stream can run past the pattern's end (trailing
  // time-fillers, with no notes), so the length comes from bars × bar length, not from the stream.
  const known = METERS[buf[buf.length - 4]];
  let beatsPerBar: number;
  let beatUnit: number;
  if (known) {
    [beatsPerBar, beatUnit] = known;
  } else {
    // Unknown code: infer the bar length from the stream, falling back to 4/4.
    const barTicks = tick > 0 && tick % bars === 0 ? tick / bars : TICKS_PER_BAR;
    [beatsPerBar, beatUnit] =
      barTicks % PPQN === 0 ? [barTicks / PPQN, 4] : barTicks % (PPQN / 2) === 0 ? [barTicks / (PPQN / 2), 8] : [4, 4];
  }
  const ticks = (bars * beatsPerBar * PPQN * 4) / beatUnit;
  const inRange = events.filter((e) => e.tick < ticks);
  return { number, label: patternLabel(number), bars, ticks, beatsPerBar, beatUnit, events: inRange };
}

export function readChain(file: string, number: number): Chain {
  const xml = fs.readFileSync(file, "utf-8");
  const repeat = /<REPEAT\s+VALUE="On"/i.test(xml);
  // NUMBER is 0-based; pattern files are 1-based.
  const patterns = [...xml.matchAll(/<PTN\s+NUMBER="(\d+)"/g)].map((m) => Number(m[1]) + 1);
  return { number, repeat, patterns };
}
