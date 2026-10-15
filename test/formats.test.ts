import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { readPadConf, padLabel, bankTempo, PAD_COUNT } from "../src/sp404/padconf.js";
import { readSmp, readSmpHeader, byteOffsetToFrame, SMP_HEADER_SIZE } from "../src/sp404/smp.js";
import { readPattern, readChain, patternLabel, PPQN } from "../src/sp404/pattern.js";
import { findProjects, loadProject, sampleFile } from "../src/sp404/project.js";
import { encodeWavFloat, encodeWav16 } from "../src/sp404/wav.js";
import { tempDir, makePadConf, makeSmp, makePattern, makeChain, writeProject, dc, W, PADCONF_SIZE, smpName } from "./support/fixtures.js";

const write = (name: string, data: Buffer | string) => {
  const f = path.join(tempDir(), name);
  fs.writeFileSync(f, data);
  return f;
};

// ---- PADCONF.BIN ----

test("PADCONF: size, magic, name and tempo header", () => {
  const buf = makePadConf({ name: "HITCHHIKERS", bpm: 82, useProjectTempo: true });
  assert.equal(buf.length, PADCONF_SIZE);
  assert.equal(PADCONF_SIZE, 52000, "same size as the unit writes");
  const conf = readPadConf(write("PADCONF.BIN", buf));
  assert.equal(conf.projectName, "HITCHHIKERS");
  assert.equal(conf.bpm, 82);
  assert.equal(conf.useProjectTempo, true);
  assert.equal(conf.pads.length, PAD_COUNT);
});

test("PADCONF: fractional tempos and per-bank tempos", () => {
  const banks = [90, 120.5, 75, 80, 81, 82, 83, 84, 85, 86];
  const conf = readPadConf(write("P", makePadConf({ bpm: 97.25, useProjectTempo: false, bankBpm: banks })));
  assert.equal(conf.bpm, 97.25);
  assert.equal(conf.useProjectTempo, false);
  assert.deepEqual(conf.bankBpm, banks);
  assert.equal(bankTempo(conf, 1), 120.5, "each pattern uses its bank's tempo");
  assert.equal(bankTempo({ ...conf, useProjectTempo: true }, 1), 97.25, "or the project tempo, when that's switched on");
});

test("PADCONF: the bank lock bit doesn't disturb the bank tempo", () => {
  const buf = makePadConf({ bankBpm: new Array(10).fill(100) });
  buf.writeUInt32BE(buf.readUInt32BE(0x40) | 1, 0x40);
  assert.equal(readPadConf(write("P", buf)).bankBpm[0], 100);
});

test("PADCONF: pad parameters decode from their words", () => {
  const words = {
    [W.volume]: 100, [W.gate]: 1, [W.loop]: 0x7fffffff, [W.muteGroup]: 2, [W.bpmSync]: 1, [W.bpm]: 9350,
    [W.pitch]: -5, [W.fine]: 25, [W.reverse]: 1, [W.speed]: 15000, [W.pan]: 10, [W.attack]: 64, [W.hold]: 50, [W.release]: 127,
  };
  const conf = readPadConf(write("P", makePadConf({ pads: [{ pad: 37, frames: 1000, words, name: "KICK" }] })));
  const p = conf.pads[37];
  assert.equal(p.label, "C6");
  assert.equal(p.name, "KICK");
  assert.equal(p.start, SMP_HEADER_SIZE);
  assert.equal(p.end, SMP_HEADER_SIZE + 4000);
  assert.deepEqual(
    [p.volume, p.gate, p.loop, p.muteGroup, p.bpmSync, p.bpm, p.pitch, p.fine, p.reverse, p.speed, p.pan, p.attack, p.hold, p.release],
    [100, true, true, 2, true, 93.5, -5, 25, true, 1.5, 10, 64, 50, 127],
  );
  assert.equal(p.raw.length, 43);
});

test("PADCONF: a hold of 0 means the whole sample", () => {
  const conf = readPadConf(write("P", makePadConf({ pads: [{ pad: 0, frames: 10, words: { [W.hold]: 0 } }] })));
  assert.equal(conf.pads[0].hold, 100);
});

test("PADCONF: empty pads read as empty", () => {
  const p = readPadConf(write("P", makePadConf())).pads[159];
  assert.equal(p.label, "J16");
  assert.equal(p.name, "");
  assert.equal(p.sampleLength, 0);
});

test("PADCONF: rejects files that aren't PADCONF", () => {
  assert.throws(() => readPadConf(write("P", Buffer.alloc(52000))), /not a PADCONF/);
});

test("pad labels run A1..J16", () => {
  assert.deepEqual([0, 15, 16, 79, 80, 159].map(padLabel), ["A1", "A16", "B1", "E16", "F1", "J16"]);
});

// ---- .SMP ----

test("SMP: stereo samples decode to floats, big-endian", () => {
  const s = readSmp(write("S.SMP", makeSmp([0.5, -0.5, 0], [-1, 0.25, 0.999], 44100)));
  assert.equal(s.rate, 44100);
  assert.equal(s.channels, 2);
  assert.deepEqual([...s.left], [0.5, -0.5, 0]);
  assert.deepEqual([...s.right], [-1, 0.25, 32735 / 32768]);
});

test("SMP: mono samples play on both sides", () => {
  const s = readSmp(write("S.SMP", makeSmp([0.25, -0.75])));
  assert.equal(s.channels, 1);
  assert.deepEqual([...s.left], [...s.right]);
});

test("SMP: header fields and rejection of other files", () => {
  const buf = makeSmp(dc(4), dc(4), 48000);
  assert.deepEqual(readSmpHeader(buf), { rate: 48000, channels: 2, bits: 16 });
  assert.throws(() => readSmpHeader(Buffer.from("RIFF0000")), /RFWV/);
  const bad = Buffer.from(buf);
  bad.writeUInt32BE(24, 16);
  assert.throws(() => readSmp(write("B.SMP", bad)), /bit depth/);
});

test("SMP: pad byte offsets convert to frames", () => {
  assert.equal(byteOffsetToFrame(SMP_HEADER_SIZE, 2), 0);
  assert.equal(byteOffsetToFrame(SMP_HEADER_SIZE + 400, 2), 100);
  assert.equal(byteOffsetToFrame(SMP_HEADER_SIZE + 400, 1), 200);
  assert.equal(byteOffsetToFrame(0, 2), 0, "offsets inside the header clamp to the start");
});

// ---- patterns and chains ----

test("pattern: notes, timing, velocity, length", () => {
  const f = write("PTN00003.BIN", makePattern([{ tick: 0, pad: 0, velocity: 100, length: 120 }, { tick: 960, pad: 5 }, { tick: 1000, pad: 15 }], 1));
  const p = readPattern(f, 3);
  assert.equal(p.label, "A3");
  assert.equal(p.bars, 1);
  assert.equal(p.ticks, 4 * PPQN);
  assert.deepEqual(p.events.map((e) => [e.tick, e.pad, e.velocity, e.length, e.note]), [
    [0, 0, 100, 120, 0], [960, 5, 127, 240, 0], [1000, 15, 127, 240, 0],
  ]);
});

test("pattern: pads in banks F-J use the high-bank flag", () => {
  const p = readPattern(write("P", makePattern([{ tick: 0, pad: 79 }, { tick: 10, pad: 80 }, { tick: 20, pad: 159 }])), 1);
  assert.deepEqual(p.events.map((e) => e.pad), [79, 80, 159]);
});

test("pattern: long gaps are bridged by filler records", () => {
  const p = readPattern(write("P", makePattern([{ tick: 0, pad: 1 }, { tick: 7000, pad: 2 }], 4)), 1);
  assert.deepEqual(p.events.map((e) => e.tick), [0, 7000]);
  assert.equal(p.ticks, 4 * 1920);
});

test("pattern: chromatic notes (stored as semitones + 12; 0 = not chromatic)", () => {
  const p = readPattern(write("P", makePattern([{ tick: 0, pad: 1, note: 7 }, { tick: 10, pad: 1, note: -11 }, { tick: 20, pad: 1, note: 12 }])), 1);
  assert.deepEqual(p.events.map((e) => e.note), [7, -11, 12]);
  assert.deepEqual(p.events.map((e) => e.raw[3]), [19, 1, 24]);
});

test("pattern: note bytes with bit 7 set are treated as unshifted", () => {
  const buf = makePattern([{ tick: 0, pad: 1 }]);
  buf[3] = 0x8c;
  assert.equal(readPattern(write("P", buf), 1).events[0].note, 0);
});

test("pattern: time signatures set the bar length", () => {
  const len = (meter: string, bars: number) => readPattern(write("P", makePattern([], bars, meter)), 1);
  assert.deepEqual([len("4/4", 2).ticks, len("4/4", 2).beatsPerBar], [3840, 4]);
  assert.deepEqual([len("3/4", 4).ticks, len("3/4", 4).beatsPerBar], [5760, 3]);
  assert.deepEqual([len("5/4", 36).ticks, len("5/4", 36).beatsPerBar], [36 * 2400, 5]);
});

test("pattern: filler running past the end doesn't lengthen the pattern, and late notes are dropped", () => {
  const p = readPattern(write("P", makePattern([{ tick: 100, pad: 1 }, { tick: 1920 + 50, pad: 2 }], 1, "4/4", { trailingTicks: 3000 })), 1);
  assert.equal(p.ticks, 1920);
  assert.deepEqual(p.events.map((e) => e.pad), [1]);
});

test("pattern: an unknown meter code falls back to the record stream's length", () => {
  const buf = makePattern([], 2, "3/4");
  buf[buf.length - 4] = 9;
  const p = readPattern(write("P", buf), 1);
  assert.equal(p.beatsPerBar, 3);
  assert.equal(p.ticks, 2 * 1440);
});

test("pattern labels", () => {
  assert.deepEqual([1, 16, 17, 160].map(patternLabel), ["A1", "A16", "B1", "J16"]);
});

test("chain: patterns (0-based in the file), repeat flag", () => {
  const c = readChain(write("PATTERNCHAIN_02.CHN", makeChain([1, 17, 17, 160], true)), 2);
  assert.deepEqual(c, { number: 2, repeat: true, patterns: [1, 17, 17, 160] });
  assert.equal(readChain(write("C", makeChain([3])), 0).repeat, false);
});

// ---- projects ----

test("loadProject reads everything and notes which pads have samples", () => {
  const dir = writeProject(tempDir(), {
    name: "LOADME",
    samples: [{ pad: 0, left: dc(10) }, { pad: 100, left: dc(10) }],
    patterns: [{ number: 2, notes: [{ tick: 0, pad: 0 }] }, { number: 1, notes: [] }],
    chains: [{ number: 3, patterns: [2, 1] }, { number: 1, patterns: [1] }],
    extraFiles: { "PTN/notes.txt": "ignored" },
  });
  const p = loadProject(dir);
  assert.equal(p.conf.projectName, "LOADME");
  assert.deepEqual([...p.patterns.keys()], [1, 2], "patterns sorted by number");
  assert.deepEqual(p.chains.map((c) => c.number), [1, 3], "chains sorted by number");
  assert.equal(p.hasSample.filter(Boolean).length, 2);
  assert.ok(p.hasSample[100]);
  assert.equal(sampleFile(dir, 100), path.join(dir, "SMPL", smpName(100)));
  assert.equal(smpName(100), "BANK7-05.SMP");
});

test("loadProject copes with a project that has no PTN folder", () => {
  const dir = writeProject(tempDir(), {});
  fs.rmSync(path.join(dir, "PTN"), { recursive: true });
  assert.equal(loadProject(dir).patterns.size, 0);
});

test("findProjects finds project folders on an SD-card-like tree, including IMPORT", () => {
  const root = tempDir();
  for (const rel of ["EXPORT/PROJECT/P1_A", "EXPORT/PROJECT/P10_B", "EXPORT/PROJECT/P2_C", "IMPORT/P3_D"]) writeProject(path.join(root, rel), {});
  fs.mkdirSync(path.join(root, ".Trashes/P9_X"), { recursive: true });
  fs.writeFileSync(path.join(root, ".Trashes/P9_X/PADCONF.BIN"), "");
  fs.mkdirSync(path.join(root, "a/b/c/d/e/P_DEEP"), { recursive: true });
  fs.writeFileSync(path.join(root, "a/b/c/d/e/P_DEEP/PADCONF.BIN"), "");
  const rel = findProjects(root).map((d) => path.relative(root, d));
  assert.deepEqual(rel, ["EXPORT/PROJECT/P1_A", "EXPORT/PROJECT/P2_C", "EXPORT/PROJECT/P10_B", "IMPORT/P3_D"], "natural order, no hidden or too-deep folders");
});

test("findProjects on a missing folder finds nothing", () => {
  assert.deepEqual(findProjects(path.join(tempDir(), "nope")), []);
});

// ---- WAV ----

test("float WAV: header and exact samples", () => {
  const l = Float32Array.from([0.5, -2, 0.125]);
  const r = Float32Array.from([1, 0, -0.25]);
  const wav = encodeWavFloat(l, r, 48000);
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(20), 3, "IEEE float");
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 48000 * 8);
  assert.equal(wav.readUInt16LE(34), 32);
  assert.equal(wav.readUInt32LE(40), 3 * 8);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => wav.readFloatLE(44 + i * 4)), [0.5, 1, -2, 0, 0.125, -0.25], "over-range values are kept, not clipped");
});

test("16-bit WAV: header, quantisation and clipping", () => {
  const wav = encodeWav16(Float32Array.from([1, -1, 2]), Float32Array.from([0, 0.5, -2]), 44100);
  assert.equal(wav.readUInt16LE(20), 1, "PCM");
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(28), 44100 * 4);
  assert.equal(wav.length, 44 + 3 * 4);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => wav.readInt16LE(44 + i * 2)), [32767, 0, -32767, 16384, 32767, -32768]);
});

test("empty WAVs are valid", () => {
  assert.equal(encodeWavFloat(new Float32Array(0), new Float32Array(0), 48000).length, 44);
});

test("PADCONF: BANK VOLUME is stored as 127 minus the level, two banks per word", () => {
  // Project 2 on the user's unit: banks at 90 store 0x25; bank F, left at 127, stores 0.
  const buf = makePadConf();
  Buffer.from("00250025002500250000002500250025", "hex").copy(buf, 0x6c);
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "PADCONF.BIN"), buf);
  assert.deepEqual(readPadConf(path.join(dir, "PADCONF.BIN")).bankVolume, [90, 90, 90, 90, 90, 127, 90, 90, 127, 127]);
});

test("PADCONF: an untouched project has every bank at 127", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "PADCONF.BIN"), makePadConf());
  assert.deepEqual(readPadConf(path.join(dir, "PADCONF.BIN")).bankVolume, new Array(10).fill(127));
});
