import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { loadProject } from "../src/sp404/project.js";
import { planRefactor, executeRefactor } from "../src/sp404/refactor.js";
import { renderStems } from "../src/sp404/render.js";
import { readPadConf } from "../src/sp404/padconf.js";
import { tempDir, writeProject, dc, W, smpName } from "./support/fixtures.js";

/** Drums on A1/A2, bass on C5, keys on F3 (bank F, high-bank flag); B9 is never played. */
function source() {
  const dir = writeProject(path.join(tempDir(), "P4_SOURCE"), {
    name: "SOURCE",
    samples: [
      { pad: 0, left: dc(4000, 0.3), name: "KICK" },
      { pad: 1, left: dc(3000, 0.2), name: "SNARE", words: { [W.muteGroup]: 1 } },
      { pad: 24, left: dc(3000, 0.1), name: "UNUSED" },
      { pad: 36, left: dc(20000, -0.2), right: dc(20000, 0.2), name: "BASS", words: { [W.pitch]: 3 } },
      { pad: 82, left: dc(9000, 0.05), name: "KEYS" },
    ],
    patterns: [
      { number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 480, pad: 1 }, { tick: 960, pad: 36, note: 4 }, { tick: 1000, pad: 82 }, { tick: 1100, pad: 140 }] },
      { number: 2, notes: [{ tick: 0, pad: 36 }, { tick: 240, pad: 0 }], meter: "3/4" },
      { number: 5, notes: [{ tick: 0, pad: 24 }] },
    ],
    chains: [{ number: 0, patterns: [1, 2, 1] }],
    extraFiles: { "PICTURE/IMG.BMP": Buffer.alloc(64, 9) },
  });
  return loadProject(dir);
}

const GROUPS = { drums: [0, 1], bass: [36] };

test("plan: each stem gets its own bank; unused pads are dropped", () => {
  const plan = planRefactor(source(), [1, 2, 1], GROUPS);
  assert.deepEqual(plan.patterns, [1, 2]);
  assert.deepEqual(plan.stems.map((s) => [s.stem, s.moves.map((m) => `${m.fromLabel}>${m.toLabel}`)]), [
    ["drums", ["A1>A1", "A2>A2"]],
    ["bass", ["C5>B1"]],
    ["Pads in no stem", ["F3>C1"]],
  ]);
  assert.equal(plan.errors.length, 0);
  assert.match(plan.warnings.join(" "), /F3/, "warns about ungrouped pads");
});

test("plan: pads played but without a sample aren't copied", () => {
  const plan = planRefactor(source(), [1], GROUPS);
  assert.ok(!plan.stems.some((s) => s.moves.some((m) => m.from === 140)));
});

test("plan: a pad in two stems goes to the first", () => {
  const plan = planRefactor(source(), [1], { a: [0], b: [0, 1] });
  assert.deepEqual(plan.stems.map((s) => s.moves.map((m) => m.from)), [[0], [1], [36, 82]]);
});

test("plan: a stem bigger than a bank spills over, with a warning", () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({ pad: i, left: dc(10) }));
  const p = loadProject(writeProject(tempDir(), { samples, patterns: [{ number: 1, notes: samples.map((s, i) => ({ tick: i * 10, pad: s.pad })) }] }));
  const plan = planRefactor(p, [1], { big: samples.map((s) => s.pad) });
  assert.equal(plan.stems[0].moves[19].toLabel, "B4");
  assert.match(plan.warnings[0], /20 pads.*2 banks.*split/);
  assert.equal(plan.errors.length, 0);
});

test("plan: more stems than banks is an error", () => {
  const samples = Array.from({ length: 11 }, (_, i) => ({ pad: i * 3, left: dc(10) }));
  const p = loadProject(writeProject(tempDir(), { samples, patterns: [{ number: 1, notes: samples.map((s, i) => ({ tick: i, pad: s.pad })) }] }));
  const groups = Object.fromEntries(samples.map((s, i) => [`s${i}`, [s.pad]]));
  assert.match(planRefactor(p, [1], groups).errors.join(), /11 banks/);
});

test("plan: a pattern that plays nothing is an error", () => {
  assert.match(planRefactor(source(), [99], {}).errors.join(), /nothing to copy/);
});

test("execute: writes a new project that sounds identical, leaving the source alone", () => {
  const src = source();
  const before = fs.readdirSync(src.dir, { recursive: true }).map(String).sort();
  const padconfBefore = fs.readFileSync(path.join(src.dir, "PADCONF.BIN"));
  const dest = path.join(path.dirname(src.dir), "P4_REFACTORED");
  const res = executeRefactor(src, [1, 2, 1], GROUPS, dest, "refactored!", 0);
  assert.deepEqual(res, { dest, samples: 4, patterns: 2 });
  assert.deepEqual(fs.readdirSync(src.dir, { recursive: true }).map(String).sort(), before, "source unchanged");
  assert.ok(fs.readFileSync(path.join(src.dir, "PADCONF.BIN")).equals(padconfBefore));

  const out = loadProject(dest);
  assert.equal(out.conf.projectName, "REFACTORED_");
  assert.deepEqual(out.hasSample.flatMap((h, i) => (h ? [i] : [])), [0, 1, 16, 32]);
  assert.equal(out.conf.pads[16].name, "BASS");
  assert.equal(out.conf.pads[16].pitch, 3, "pad settings move with the sample");
  assert.equal(out.conf.pads[1].muteGroup, 1);
  assert.ok(fs.readFileSync(path.join(dest, "SMPL", smpName(16))).equals(fs.readFileSync(path.join(src.dir, "SMPL", smpName(36)))));
  assert.deepEqual([...out.patterns.keys()], [1, 2], "only the chain's patterns");
  assert.deepEqual(out.chains.map((c) => c.patterns), [[1, 2, 1]]);
  assert.ok(fs.existsSync(path.join(dest, "PICTURE", "IMG.BMP")));

  // Same audio, stem for stem, with groups mapped to the new pads.
  const a = renderStems(src, [1, 2, 1], GROUPS, { tail: "extend" });
  const b = renderStems(out, [1, 2, 1], { drums: [0, 1], bass: [16] }, { tail: "extend" });
  assert.equal(a.frames, b.frames);
  for (const name of ["drums", "bass"]) assert.deepEqual(b.stems.get(name)!.left, a.stems.get(name)!.left, name);
  assert.deepEqual(b.mix.right, a.mix.right);
});

test("execute: notes on pads with no sample become timing-only records", () => {
  const src = source();
  const dest = path.join(tempDir(), "OUT");
  executeRefactor(src, [1], GROUPS, dest, "OUT");
  const before = src.patterns.get(1)!;
  const after = loadProject(dest).patterns.get(1)!;
  assert.equal(after.ticks, before.ticks);
  assert.equal(after.events.length, before.events.length - 1);
  assert.deepEqual(after.events.map((e) => e.tick), before.events.filter((e) => e.pad !== 140).map((e) => e.tick));
  assert.equal(fs.statSync(path.join(dest, "PTN", "PTN00001.BIN")).size, fs.statSync(path.join(src.dir, "PTN", "PTN00001.BIN")).size);
});

test("execute: empty slots look like the unit's own empty pads", () => {
  const dest = path.join(tempDir(), "OUT");
  executeRefactor(source(), [1], GROUPS, dest, "OUT");
  const conf = readPadConf(path.join(dest, "PADCONF.BIN"));
  const empty = conf.pads[100];
  assert.deepEqual([empty.volume, empty.gate, empty.bpm, empty.speed, empty.pan, empty.hold], [127, true, 90, 1, 64, 100]);
  assert.equal(fs.statSync(path.join(dest, "PADCONF.BIN")).size, 52000);
});

test("execute: refuses to overwrite an existing folder", () => {
  const dest = tempDir();
  assert.throws(() => executeRefactor(source(), [1], GROUPS, dest, "X"), /already exists/);
});

test("execute: refuses a plan with errors, writing nothing", () => {
  const dest = path.join(tempDir(), "OUT");
  assert.throws(() => executeRefactor(source(), [99], GROUPS, dest, "X"), /nothing to copy/);
  assert.ok(!fs.existsSync(dest));
});
