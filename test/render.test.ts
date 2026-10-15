import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { loadProject, Project } from "../src/sp404/project.js";
import { renderStems, renderPad, bankGain, panGains, patternBpm, OUTPUT_RATE, StereoBuffer, RenderOptions } from "../src/sp404/render.js";
import { tempDir, writeProject, ProjectSpec, dc, W, framesPerTick } from "./support/fixtures.js";

const project = (spec: ProjectSpec): Project => loadProject(writeProject(tempDir(), spec));
const CUT: RenderOptions = { tail: "cut" };
const SEC = OUTPUT_RATE;
const PAN_L = 1; // centre pan: both sides at full level

const peak = (b: StereoBuffer, from: number, to: number) => {
  let m = 0;
  for (let i = Math.max(0, Math.floor(from)); i < Math.min(Math.ceil(to), b.left.length); i++) m = Math.max(m, Math.abs(b.left[i]), Math.abs(b.right[i]));
  return m;
};
const silent = (b: StereoBuffer, from: number, to: number) => peak(b, from, to) < 1e-6;
const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const firstSound = (b: StereoBuffer) => b.left.findIndex((v) => Math.abs(v) > 1e-6);
const lastSound = (b: StereoBuffer) => {
  for (let i = b.left.length - 1; i >= 0; i--) if (Math.abs(b.left[i]) > 1e-6) return i;
  return -1;
};

// One bar of 4/4 at 120 BPM = 2 s.
const BAR = 2 * SEC;
const TICK = framesPerTick(120);

test("hits land on their tick, at the pattern's tempo", () => {
  const p = project({ bpm: 120, samples: [{ pad: 0, left: dc(100) }], patterns: [{ number: 1, notes: [{ tick: 480, pad: 0 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  assert.equal(r.frames, BAR);
  assert.equal(firstSound(r.mix), 480 * TICK);
  assert.equal(firstSound(r.mix), SEC / 2);
  close(r.mix.left[SEC / 2], 0.5 * PAN_L);
});

test("pattern length follows bars and time signature", () => {
  const p = project({ bpm: 90, patterns: [{ number: 1, notes: [], bars: 3, meter: "5/4" }, { number: 2, notes: [], bars: 2, meter: "3/4" }] });
  assert.equal(renderStems(p, [1], {}, CUT).frames, Math.round(3 * 5 * (60 / 90) * SEC));
  assert.equal(renderStems(p, [2], {}, CUT).frames, Math.round(2 * 3 * (60 / 90) * SEC));
  assert.equal(renderStems(p, [1, 2], {}, CUT).frames, Math.round(21 * (60 / 90) * SEC));
});

test("the timeline describes each pattern in a chain", () => {
  const p = project({ bpm: 120, patterns: [{ number: 1, notes: [], bars: 2 }, { number: 17, notes: [], meter: "3/4" }] });
  const r = renderStems(p, [1, 17, 1], {}, CUT);
  assert.deepEqual(r.timeline.segments.map((s) => [s.label, s.start, s.end, s.beatsPerBar]), [
    ["A1", 0, 2 * BAR, 4], ["B1", 2 * BAR, 2 * BAR + 1.5 * SEC, 3], ["B1", 0, 0, 0],
  ].slice(0, 2).concat([["A1", 2 * BAR + 1.5 * SEC, 4 * BAR + 1.5 * SEC, 4]]));
});

test("missing patterns in a sequence are skipped", () => {
  const p = project({ patterns: [{ number: 1, notes: [] }] });
  assert.equal(renderStems(p, [1, 99, 1], {}, CUT).frames, 2 * BAR);
});

test("stems sum exactly to the mix; ungrouped pads get their own stem", () => {
  const p = project({
    samples: [{ pad: 0, left: dc(5000, 0.3) }, { pad: 1, left: dc(5000, -0.2), right: dc(5000, 0.1) }, { pad: 16, left: dc(3000, 0.05) }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 100, pad: 1 }, { tick: 200, pad: 16 }, { tick: 960, pad: 0 }] }],
  });
  const r = renderStems(p, [1], { drums: [0], bass: [1] }, CUT);
  assert.deepEqual([...r.stems.keys()].sort(), ["bass", "drums", "ungrouped"]);
  for (let i = 0; i < r.frames; i++) {
    let l = 0;
    let rr = 0;
    for (const s of r.stems.values()) {
      l += s.left[i];
      rr += s.right[i];
    }
    assert.equal(l, r.mix.left[i]);
    assert.equal(rr, r.mix.right[i]);
  }
  assert.deepEqual(r.usedPads, [0, 1, 16]);
});

test("pads without a sample are ignored", () => {
  const p = project({ samples: [{ pad: 0, left: dc(10) }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 5 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  assert.equal(r.stems.size, 0);
  assert.ok(silent(r.mix, 0, r.frames));
});

test("velocity and pad volume scale the level", () => {
  const p = project({
    samples: [{ pad: 0, left: dc(100) }, { pad: 1, left: dc(100), words: { [W.volume]: 64 } }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0, velocity: 64 }, { tick: 960, pad: 1 }] }],
  });
  const r = renderStems(p, [1], {}, CUT);
  close(r.mix.left[0], 0.5 * (64 / 127) * PAN_L);
  close(r.mix.left[960 * TICK], 0.5 * (64 / 127) * PAN_L);
});

test("pan: hard left and hard right (L50 / R50)", () => {
  const p = project({
    samples: [{ pad: 0, left: dc(100), words: { [W.pan]: 14 } }, { pad: 1, left: dc(100), words: { [W.pan]: 114 } }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 960, pad: 1 }] }],
  });
  const r = renderStems(p, [1], {}, CUT);
  close(r.mix.left[0], 0.5);
  close(r.mix.right[0], 0);
  close(r.mix.left[960 * TICK], 0);
  close(r.mix.right[960 * TICK], 0.5);
});

test("pan MONO (Left/Right): one channel of the sample on both outputs, the other dropped", () => {
  const p = project({
    samples: [
      { pad: 0, left: dc(100, 0.5), right: dc(100, -0.25), words: { [W.pan]: 13 } },
      { pad: 1, left: dc(100, 0.5), right: dc(100, -0.25), words: { [W.pan]: 115 } },
    ],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 960, pad: 1 }] }],
  });
  const r = renderStems(p, [1], {}, CUT);
  close(r.mix.left[0], 0.5);
  close(r.mix.right[0], 0.5);
  close(r.mix.left[960 * TICK], -0.25);
  close(r.mix.right[960 * TICK], -0.25);
});

test("a one-shot plays its whole sample, then stops", () => {
  const p = project({ samples: [{ pad: 0, left: dc(1000) }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0, length: 1 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  assert.equal(lastSound(r.mix), 998);
});

test("gate: the sound stops when the note is released (5 ms fade)", () => {
  const p = project({ samples: [{ pad: 0, left: dc(SEC), words: { [W.gate]: 1 } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0, length: 240 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  const off = 240 * TICK;
  assert.ok(peak(r.mix, off - 10, off) > 0.4);
  assert.ok(silent(r.mix, off + 240, r.frames));
  assert.equal(r.timeline.hits[0].cut, "gate");
});

test("gate: release time still applies after the note is released", () => {
  const release = 127; // 3 s
  const p = project({ samples: [{ pad: 0, left: dc(4 * SEC), words: { [W.gate]: 1, [W.release]: release } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0, length: 240 }] }, { number: 2, notes: [], bars: 2 }] });
  const r = renderStems(p, [1], {}, { tail: "extend" });
  const off = 240 * TICK;
  assert.ok(peak(r.mix, off + SEC, off + SEC + 10) > 0.05, "still fading a second later");
  assert.ok(silent(r.mix, off + 3 * SEC + 10, r.frames), "gone after the release time");
});

test("hold plays only part of the sample", () => {
  const p = project({ samples: [{ pad: 0, left: dc(1000), words: { [W.hold]: 50 } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }] });
  assert.equal(lastSound(renderStems(p, [1], {}, CUT).mix), 498);
});

test("attack fades in linearly over its time (127 = 3 s)", () => {
  const p = project({ samples: [{ pad: 0, left: dc(4 * SEC), words: { [W.attack]: 127 } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }], bars: 2 }] });
  const r = renderStems(p, [1], {}, CUT);
  close(r.mix.left[0], 0);
  close(r.mix.left[1.5 * SEC] / r.mix.left[0.75 * SEC], 2, 1e-3);
  close(r.mix.left[3.5 * SEC], 0.5 * PAN_L, 1e-3);
});

test("retriggering a pad cuts its previous sound", () => {
  const p = project({ samples: [{ pad: 0, left: dc(SEC) }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 240, pad: 0 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  assert.equal(r.timeline.hits[0].cut, "retrigger");
  close(r.mix.left[240 * TICK + 300], 0.5 * PAN_L, 1e-3); // one voice, not two stacked
});

test("a retrigger at a different chromatic note lets the first one ring", () => {
  const p = project({ samples: [{ pad: 0, left: dc(SEC) }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 240, pad: 0, note: 5 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  assert.equal(r.timeline.hits[0].cut, undefined);
  close(r.mix.left[240 * TICK + 300], 2 * 0.5 * PAN_L, 1e-3);
});

test("mute groups: a new pad releases the other pad's sound", () => {
  const words = { [W.muteGroup]: 2 };
  const p = project({
    samples: [{ pad: 0, left: dc(SEC), words }, { pad: 1, left: dc(SEC, 0.25), words }, { pad: 2, left: dc(SEC, 0.125) }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 0, pad: 2 }, { tick: 480, pad: 1 }] }],
  });
  const r = renderStems(p, [1], { a: [0], b: [1], c: [2] }, CUT);
  const t = 480 * TICK;
  assert.ok(silent(r.stems.get("a")!, t + 240, r.frames), "pad 0 cut by pad 1");
  assert.ok(peak(r.stems.get("c")!, t + 1000, t + 1001) > 0.1, "pads outside the group keep playing");
  assert.equal(r.timeline.hits.find((h) => h.pad === 0)!.cut, "mute group");
});

test("mute groups respect the release of the pad being cut", () => {
  const p = project({
    samples: [{ pad: 0, left: dc(4 * SEC), words: { [W.muteGroup]: 1, [W.release]: 64 } }, { pad: 1, left: dc(10), words: { [W.muteGroup]: 1 } }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 480, pad: 1 }], bars: 2 }],
  });
  const r = renderStems(p, [1], { a: [0] }, CUT);
  const t = 480 * TICK;
  const rel = Math.round((64 / 127) * 3 * SEC);
  assert.ok(peak(r.stems.get("a")!, t + rel / 2, t + rel / 2 + 1) > 0.05, "overlaps while releasing");
  assert.ok(silent(r.stems.get("a")!, t + rel + 1, r.frames));
});

test("an ungated loop plays until hit again", () => {
  const p = project({ samples: [{ pad: 0, left: dc(1000), words: { [W.loop]: 0x7fffffff } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 960, pad: 0 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  assert.ok(peak(r.mix, 900 * TICK, 900 * TICK + 1) > 0.4, "still looping long after the sample's length");
  assert.ok(silent(r.mix, 960 * TICK + 240, r.frames), "second hit stops it");
  assert.equal(r.timeline.hits.length, 1);
  assert.equal(r.timeline.hits[0].cut, "loop toggle");
});

test("loops stop at the end of the sequence", () => {
  const p = project({ samples: [{ pad: 0, left: dc(1000), words: { [W.loop]: 0x7fffffff } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }] });
  const r = renderStems(p, [1], {}, { tail: "extend" });
  assert.ok(r.frames <= BAR + 240);
});

// A chain where pattern 1's sound outlasts it, then pattern 2 starts.
const ringing = () => project({
  samples: [{ pad: 0, left: dc(3 * SEC) }],
  patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }, { number: 2, notes: [] }],
});

test("MK2 continuation: a new pattern cuts sounds from the previous one", () => {
  const r = renderStems(ringing(), [1, 2], {}, { tail: "cut", continuation: "mk2" });
  assert.ok(silent(r.mix, BAR + 240, r.frames));
  assert.equal(r.timeline.hits[0].cut, "pattern change");
});

test("SX continuation: sounds ring on into the next pattern", () => {
  const r = renderStems(ringing(), [1, 2], {}, { tail: "cut", continuation: "sx" });
  assert.ok(peak(r.mix, BAR + SEC / 2, BAR + SEC / 2 + 1) > 0.4);
  assert.ok(silent(r.mix, 3 * SEC, r.frames));
});

test("MK2 continuation: a pattern repeating itself doesn't cut", () => {
  const r = renderStems(ringing(), [1, 1], {}, { tail: "cut", continuation: "mk2" });
  assert.ok(peak(r.mix, BAR + SEC / 2, BAR + SEC / 2 + 1) > 0.4);
});

test("tail modes: cut, extend, wrap", () => {
  const p = project({ samples: [{ pad: 0, left: dc(3 * SEC) }], patterns: [{ number: 1, notes: [{ tick: 960, pad: 0 }] }] });
  const cut = renderStems(p, [1], {}, { tail: "cut" });
  const ext = renderStems(p, [1], {}, { tail: "extend" });
  const wrap = renderStems(p, [1], {}, { tail: "wrap" });
  assert.equal(cut.frames, BAR);
  assert.equal(ext.frames, SEC + 3 * SEC - 1);
  assert.equal(wrap.frames, BAR);
  assert.ok(silent(cut.mix, 0, SEC));
  assert.ok(peak(wrap.mix, 0, 10) > 0.4, "the tail is heard at the start, as when looping");
  assert.ok(silent(wrap.mix, 2 * SEC - 1 - SEC + 10, SEC), "until the tail ends");
});

test("tempo: bank tempo when the project tempo is off, the override when given", () => {
  const p = project({
    bpm: 120, useProjectTempo: false, bankBpm: [60, 90, 120, 120, 120, 120, 120, 120, 120, 120],
    patterns: [{ number: 1, notes: [] }, { number: 17, notes: [] }],
  });
  assert.equal(patternBpm(p, 1, CUT), 60);
  assert.equal(patternBpm(p, 17, CUT), 90);
  assert.equal(renderStems(p, [1], {}, CUT).frames, 4 * SEC);
  assert.equal(renderStems(p, [17], {}, CUT).frames, Math.round((8 / 3) * SEC));
  assert.equal(renderStems(p, [1], {}, { tail: "cut", bpm: 240 }).frames, SEC);
});

test("tempo: the project tempo applies to every pattern when switched on", () => {
  const p = project({ bpm: 100, useProjectTempo: true, bankBpm: new Array(10).fill(60), patterns: [{ number: 33, notes: [] }] });
  assert.equal(patternBpm(p, 33, CUT), 100);
});

test("VINYL pitch: +12 semitones plays twice as fast", () => {
  const p = project({ samples: [{ pad: 0, left: dc(2000), words: { [W.pitch]: 12 } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }] });
  const end = lastSound(renderStems(p, [1], {}, CUT).mix);
  assert.ok(Math.abs(end - 1000) <= 2, `ended at ${end}`);
});

test("VINYL: chromatic notes shift pitch and speed together", () => {
  const p = project({ samples: [{ pad: 0, left: dc(2000) }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0, note: -11 }] }] });
  const end = lastSound(renderStems(p, [1], {}, CUT).mix);
  const expect = 1999 * Math.pow(2, 11 / 12);
  assert.ok(Math.abs(end - expect) < 5, `ended at ${end}, expected ~${expect}`);
});

test("samples at other rates are resampled to 48 kHz", () => {
  const dir = writeProject(tempDir(), { samples: [{ pad: 0, left: dc(1000) }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }] });
  // Rewrite the sample's rate field to 24 kHz.
  const f = `${dir}/SMPL/BANK1-01.SMP`;
  const buf = fs.readFileSync(f);
  buf.writeUInt32BE(24000, 8);
  fs.writeFileSync(f, buf);
  const end = lastSound(renderStems(loadProject(dir), [1], {}, CUT).mix);
  assert.ok(Math.abs(end - 999 * 2) <= 2, `ended at ${end}`);
});

test("reverse plays the sample backwards", () => {
  const ramp = Float32Array.from({ length: 1000 }, (_, i) => i / 2000);
  const p = project({ samples: [{ pad: 0, left: ramp, words: { [W.reverse]: 1 } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  assert.ok(r.mix.left[0] > r.mix.left[500]);
  assert.ok(r.mix.left[500] > r.mix.left[900]);
});

test("BPM sync without VINYL changes length but not pitch", () => {
  // A sine at 1 kHz, synced at 60 BPM, played at 120 BPM: half as long, same frequency.
  const sine = Float32Array.from({ length: SEC }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SEC));
  const p = project({
    bpm: 120,
    samples: [{ pad: 0, left: sine, words: { [W.mode]: 0, [W.bpmSync]: 1, [W.bpm]: 6000 } }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }],
  });
  const r = renderStems(p, [1], {}, CUT);
  const end = lastSound(r.mix);
  assert.ok(Math.abs(end - SEC / 2) < 0.02 * SEC, `ended at ${end}`);
  let crossings = 0;
  for (let i = 1000; i < 1000 + SEC / 10; i++) if (r.mix.left[i - 1] < 0 && r.mix.left[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 100) <= 3, `${crossings} cycles in 0.1 s`);
});

test("VINYL ignores BPM sync and its stale SPEED: only the pitch sets the rate", () => {
  // ORANGUTANGO B9: VINYL, synced at 93.03 BPM in a 77 BPM project, pitch -4, speed 0.92. Plays at 2^(-4/12).
  const p = project({
    bpm: 77,
    samples: [{ pad: 0, left: dc(SEC), words: { [W.bpmSync]: 1, [W.bpm]: 9303, [W.pitch]: -4, [W.speed]: 9200 } }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }],
  });
  const end = lastSound(renderStems(p, [1], {}, CUT).mix);
  const expect = (SEC - 1) * Math.pow(2, 4 / 12);
  assert.ok(Math.abs(end - expect) <= 3, `ended at ${end}, expected ~${expect}`);
});

test("VINYL without sync: SPEED and pitch multiply", () => {
  // ORANGUTANGO A6 keeps its vinyl rate in SPEED: pitch 0, speed 0.8408 (= -3 semitones).
  const p = project({ samples: [{ pad: 0, left: dc(SEC), words: { [W.speed]: 8408, [W.pitch]: 2 } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }] });
  const end = lastSound(renderStems(p, [1], {}, CUT).mix);
  const expect = (SEC - 1) / (0.8408 * Math.pow(2, 2 / 12));
  assert.ok(Math.abs(end - expect) <= 3, `ended at ${end}, expected ~${expect}`);
});

test("hits report where each sound plays and why it stopped", () => {
  const p = project({ samples: [{ pad: 3, left: dc(1000) }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 3 }] }] });
  assert.deepEqual(renderStems(p, [1], {}, CUT).timeline.hits, [{ pad: 3, start: 0, end: 999, cut: undefined }]);
});

test("renderPad: one hit of a pad, at its volume", () => {
  const p = project({ samples: [{ pad: 7, left: dc(1000), words: { [W.volume]: 127, [W.loop]: 0x7fffffff } }] });
  const b = renderPad(p, 7);
  assert.ok(Math.abs(b.left.length - 999) <= 2, "no looping in a preview");
  close(b.left[10], 0.5 * PAN_L);
  assert.equal(renderPad(p, 8).left.length, 0, "silent for a pad with no sample range");
});

test("BANK VOLUME scales every pad in its bank by (volume/127)^2, in patterns and previews", () => {
  const bankVolume = [127, 90, 127, 127, 127, 127, 127, 127, 127, 127];
  const p = project({
    bankVolume,
    samples: [{ pad: 0, left: dc(1000) }, { pad: 16, left: dc(1000) }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }, { number: 2, notes: [{ tick: 0, pad: 16 }] }],
  });
  close(renderStems(p, [1], {}, CUT).mix.left[10], 0.5 * PAN_L);
  close(renderStems(p, [2], {}, CUT).mix.left[10], 0.5 * (90 / 127) ** 2 * PAN_L);
  close(renderPad(p, 16).left[10], 0.5 * (90 / 127) ** 2 * PAN_L);
});

test("bankGain: matches the unit's resample of a full-volume pad from a bank at 64", () => {
  close(bankGain(64), 0.25377, 5e-4); // measured: project 5, F10 resampled to C15
  close(bankGain(127), 1);
  close(bankGain(0), 0);
});

test("pad volume is linear: matches the unit's resample of a pad at 64", () => {
  // Measured: project 5, F10 at pad volume 64 in a bank at 127, resampled to C15 at 0.50393.
  const p = project({ samples: [{ pad: 0, left: dc(1000), words: { [W.volume]: 64 } }] });
  close(renderPad(p, 0).left[10] / (0.5 * PAN_L), 0.50393, 5e-4);
});

test("velocity is linear: matches the unit's resample of a pattern", () => {
  // Measured: project 5 patterns B2 (played) and B3 (TR-REC, 10..127), F10 resampled to C15; every hit came out at
  // velocity/127 within 0.1 dB (127 itself read 0.9953, likely clipping: F10 peaks at full scale).
  const measured: [number, number][] = [[2, 0.0156], [5, 0.0392], [14, 0.11007], [25, 0.19665], [40, 0.31479], [70, 0.55123], [100, 0.78683]];
  const p = project({ samples: [{ pad: 0, left: dc(400) }], patterns: [{ number: 1, notes: measured.map(([v], i) => ({ tick: i * 240, pad: 0, velocity: v })) }] });
  const r = renderStems(p, [1], {}, CUT);
  measured.forEach(([, g], i) => close(r.mix.left[i * 240 * TICK + 10] / (0.5 * PAN_L), g, 1e-3));
});

test("pan is a balance: matches the unit's resample at L25 and R25", () => {
  // Measured: project 5, F10 at L25 (stored 39) and a copy at R25 (89), resampled to C15.
  const [l25L, l25R] = panGains(39), [r25L, r25R] = panGains(89);
  close(l25L, 0.9964, 5e-3); // the near side is a hair under 1 on the unit, likely clipping (F10 peaks at full scale)
  close(l25R, 0.4993, 1e-3);
  close(r25L, 0.4996, 1e-3);
  close(r25R, 0.9983, 5e-3);
  assert.deepEqual(panGains(64), [1, 1]);
  assert.deepEqual(panGains(14), [1, 0]);
  assert.deepEqual(panGains(13), [1, 1]);
});

test("pan never mixes the channels: a left-only sample panned right stays left-only, quieter", () => {
  const p = project({ samples: [{ pad: 0, left: dc(100), right: dc(100, 0), words: { [W.pan]: 89 } }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }] }] });
  const r = renderStems(p, [1], {}, CUT);
  close(r.mix.left[10], 0.25);
  close(r.mix.right[10], 0);
});
