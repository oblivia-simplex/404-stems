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
  reverse: boolean; // PLAY (word 15) bit 0: 0 Normal-A, 1 Reverse-A, 2 Normal-B, 3 Reverse-B
  pingPong: boolean; // PLAY bit 1 ("-B"): the loop plays forwards then backwards (SHIFT + LOOP; Roland's app: Ping-Pong)
  vinyl: boolean; // word 17 (firmware labels it VINYL)
  fixedVelocity: boolean; // word 10 bit 0; affects live hits only, not velocities already in patterns (measured)
  oneShot: boolean; // word 10 bit 5: plays to the end, ignores hits while sounding
  speed: number; // 1.0 = 100%
  pan: number; // 0..127, 64 = centre
  attack: number; // envelope fade-in, 0..127 (127 = 3 s)
  hold: number; // envelope: % of the start..end range that plays, 1..100
  release: number; // envelope fade-out, 0..127 (127 = 3 s)
  raw: number[]; // all 43 words, for fields not decoded yet
}

export interface PadConf {
  projectName: string;
  bpm: number; // project tempo
  // When false, each pattern plays at the tempo of the bank it is stored in (bankBpm) instead.
  useProjectTempo: boolean;
  bankBpm: number[];
  // BANK VOLUME per bank, 0..127 (127 = the default, full level).
  bankVolume: number[];
  pads: PadParams[];
}

export function bankTempo(conf: PadConf, bank: number): number {
  return conf.useProjectTempo ? conf.bpm : conf.bankBpm[bank];
}

// BANK VOLUME: header 0x6C..0x7F, one 16-bit value per bank (firmware IDs 0x35..0x3E). Each 32-bit word holds two
// banks, the even one in its low half, so it comes second in the big-endian file. Stored as 127 - volume, so untouched
// projects store 0 (confirmed on the user's unit: banks at 90 store 0x25).
export function bankVolumeOffset(bank: number): number {
  return 0x6c + 4 * (bank >> 1) + (bank % 2 === 0 ? 2 : 0);
}

export function padLabel(index: number): string {
  return `${BANKS[Math.floor(index / 16)]}${(index % 16) + 1}`;
}

export function readPadConf(file: string): PadConf {
  const buf = fs.readFileSync(file);
  if (buf.toString("latin1", 0, 4) !== "RFPD") throw new Error(`${file}: not a PADCONF file`);
  const projectName = buf.toString("latin1", 0x80, 0xa0).replace(/\0.*$/s, "").trim();
  // Header word 0x10: low 16 bits = project tempo ×100; bit 16 set = use it for every pattern.
  const tempoWord = buf.readUInt32BE(0x10);
  const bpm = (tempoWord & 0xffff) / 100;
  const useProjectTempo = (tempoWord & 0x10000) !== 0;
  // Bank words: tempo ×100 << 1; bit 0 locks the bank's pad settings.
  const bankBpm = Array.from({ length: 10 }, (_, b) => (buf.readUInt32BE(0x40 + b * 4) >>> 1) / 100);
  const bankVolume = Array.from({ length: 10 }, (_, b) => Math.max(0, 127 - buf.readUInt16BE(bankVolumeOffset(b))));
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
      reverse: (w[15] & 1) !== 0,
      pingPong: (w[15] & 2) !== 0,
      vinyl: w[17] === 1,
      fixedVelocity: (w[10] & 1) !== 0,
      oneShot: (w[10] & 0x20) !== 0,
      speed: w[16] / 10000,
      pan: w[18],
      attack: w[22],
      hold: w[23] > 0 ? w[23] : 100,
      release: w[24],
      raw: w,
    });
  }
  return { projectName, bpm, useProjectTempo, bankBpm, bankVolume, pads };
}
