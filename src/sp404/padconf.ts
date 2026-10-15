import * as fs from "fs";

// PADCONF.BIN (magic "RFPD"). Field meanings: docs/sp404mk2-project-format.md.
export const PAD_COUNT = 160;
export const BANKS = "ABCDEFGHIJ";
const HEADER_SIZE = 0xa0;
const RECORD_SIZE = 0xac;
const NAME_SIZE = 24;

export interface PadParams {
  index: number; // 0..159
  label: string; // e.g. "A1"
  name: string;
  sampleLength: number; // byte offsets into the .SMP file
  start: number;
  end: number;
  loopStart: number;
  volume: number; // 0..127
  gate: boolean;
  loop: boolean;
  muteGroup: number; // 0 = off
  bpmSync: boolean;
  bpm: number;
  pitch: number; // semitones
  fine: number; // cents
  reverse: boolean;
  speed: number; // 1.0 = 100%
  pan: number; // 0..127, 64 = centre
  raw: number[]; // all 43 words, for fields not decoded yet
}

export interface PadConf {
  projectName: string;
  // Tempo per bank A..J; a pattern plays at the tempo of the bank it is stored in.
  bankBpm: number[];
  pads: PadParams[];
}

export function padLabel(index: number): string {
  return `${BANKS[Math.floor(index / 16)]}${(index % 16) + 1}`;
}

export function readPadConf(file: string): PadConf {
  const buf = fs.readFileSync(file);
  if (buf.toString("latin1", 0, 4) !== "RFPD") throw new Error(`${file}: not a PADCONF file`);
  const projectName = buf.toString("latin1", 0x80, 0xa0).replace(/\0.*$/s, "").trim();
  const bankBpm = Array.from({ length: 10 }, (_, b) => (buf.readUInt32BE(0x40 + b * 4) >>> 1) / 100);
  const namesAt = HEADER_SIZE + PAD_COUNT * RECORD_SIZE;
  const pads: PadParams[] = [];
  for (let i = 0; i < PAD_COUNT; i++) {
    const o = HEADER_SIZE + i * RECORD_SIZE;
    const w = Array.from({ length: RECORD_SIZE / 4 }, (_, k) => buf.readInt32BE(o + k * 4));
    const nameBytes = buf.subarray(namesAt + i * NAME_SIZE, namesAt + (i + 1) * NAME_SIZE);
    pads.push({
      index: i,
      label: padLabel(i),
      name: nameBytes.toString("latin1").replace(/\0.*$/s, "").trim(),
      sampleLength: w[0],
      start: w[1],
      end: w[2],
      loopStart: w[11],
      volume: w[3],
      gate: w[4] !== 0,
      loop: w[5] !== 0,
      muteGroup: w[7],
      bpmSync: w[8] !== 0,
      bpm: w[9] / 100,
      pitch: w[13],
      fine: w[14],
      reverse: w[15] !== 0,
      speed: w[16] / 10000,
      pan: w[18],
      raw: w,
    });
  }
  return { projectName, bankBpm, pads };
}
