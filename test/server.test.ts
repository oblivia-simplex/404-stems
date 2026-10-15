import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { startServer, RunningServer } from "../src/server.js";
import { Sp404Device } from "../src/sp404/remote/device.js";
import { FakeSp404 } from "./support/fakeSp404.js";
import { tempDir, writeProject, dc } from "./support/fixtures.js";

const root = tempDir("sp404-sd-");
const projectDir = writeProject(path.join(root, "EXPORT", "PROJECT", "P1_DEMO"), {
  name: "DEMO",
  bpm: 120,
  samples: [{ pad: 0, left: dc(2000, 0.4) }, { pad: 1, left: dc(2000, 0.2) }],
  patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 480, pad: 1 }] }, { number: 2, notes: [], meter: "5/4" }],
  chains: [{ number: 0, patterns: [1, 2] }],
});
const outDir = tempDir("sp404-out-");
const deviceDir = tempDir("sp404-copies-");
const unit = tempDir("sp404-unit-");
writeProject(path.join(unit, "ROLAND", "SP-404MKII", "PROJECT_07"), { name: "ON THE UNIT", samples: [{ pad: 3, left: dc(100) }] });

let deviceConnected = true;
const revealed: string[] = [];
const servers: RunningServer[] = [];
after(() => Promise.all(servers.map((s) => s.close())));

async function start(extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  const s = await startServer({
    root, port: 0, outDir, deviceDir,
    reveal: (f) => revealed.push(f),
    openDevice: async () => (deviceConnected ? new Sp404Device(new FakeSp404(unit), { reply: 300, busy: 600 }) : undefined),
    ...extra,
  });
  servers.push(s);
  return s;
}

const call = async (s: RunningServer, p: string, body?: unknown) => {
  const res = await fetch(new URL(p, s.url), body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

test("serves the UI", async () => {
  const s = await start();
  const page = await call(s, "/");
  assert.equal(page.status, 200);
  assert.match(page.type, /html/);
  assert.match(page.body.toString(), /Copy from SP-404/);
  assert.equal((await call(s, "/app.js")).type, "text/javascript");
});

test("doesn't serve files outside the UI folder", async () => {
  const s = await start();
  assert.equal((await call(s, "/../package.json")).status, 404);
  assert.equal((await call(s, "/%2e%2e/package.json")).status, 404);
  assert.equal((await call(s, "/nope.html")).status, 404);
});

test("config reports folders and whether a native folder picker exists", async () => {
  const s = await start();
  assert.deepEqual((await call(s, "/api/config")).body, { root, outDir, deviceDir, canChooseFolder: false });
  const native = await start({ chooseFolder: async (from) => `${from}/picked` });
  assert.equal((await call(native, "/api/config")).body.canChooseFolder, true);
  assert.deepEqual((await call(native, "/api/choose-folder?start=/x")).body, { path: "/x/picked" });
  assert.equal((await call(s, "/api/choose-folder")).status, 404);
});

test("lists projects under the root, and under any other folder asked for", async () => {
  const s = await start();
  assert.deepEqual((await call(s, "/api/projects")).body, { root, projects: [{ dir: projectDir, name: "EXPORT/PROJECT/P1_DEMO" }] });
  assert.deepEqual((await call(s, `/api/projects?root=${encodeURIComponent(outDir)}`)).body.projects, []);
});

test("describes a project", async () => {
  const s = await start();
  const p = (await call(s, `/api/project?dir=${encodeURIComponent(projectDir)}`)).body;
  assert.equal(p.name, "DEMO");
  assert.equal(p.bpm, 120);
  assert.equal(p.pads.length, 160);
  assert.equal(p.pads[0].hasSample, true);
  assert.equal(p.pads[0].raw, undefined, "raw words aren't sent to the page");
  assert.deepEqual(p.patterns.map((x: { label: string; meter: string; pads: number[] }) => [x.label, x.meter, x.pads]), [["A1", "4/4", [0, 1]], ["A2", "5/4", []]]);
  assert.deepEqual(p.chains, [{ number: 0, repeat: false, patterns: [1, 2] }]);
});

test("a broken project gives an error message, not a crash", async () => {
  const s = await start();
  const r = await call(s, `/api/project?dir=${encodeURIComponent(outDir)}`);
  assert.equal(r.status, 500);
  assert.match(r.body.error, /ENOENT|PADCONF/);
});

test("pad previews are 16-bit WAVs; empty pads are silent", async () => {
  const s = await start();
  const wav = (await call(s, `/api/pad.wav?dir=${encodeURIComponent(projectDir)}&pad=0`)).body as Buffer;
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(wav.readUInt16LE(34), 16);
  assert.ok(wav.length > 44 + 1990 * 4);
  const empty = await call(s, `/api/pad.wav?dir=${encodeURIComponent(projectDir)}&pad=99`);
  assert.equal(empty.status, 200);
  assert.equal((empty.body as Buffer).length, 44);
});

const req = { dir: projectDir, sequence: [1, 2], groups: { kick: [0] }, tail: "cut" };

test("render reports stems, timeline and hits", async () => {
  const s = await start();
  const r = (await call(s, "/api/render", req)).body;
  assert.deepEqual(r.stems.sort(), ["kick", "ungrouped"]);
  assert.equal(r.seconds, 2 + 2.5);
  assert.deepEqual(r.segments.map((x: { label: string; start: number; end: number }) => [x.label, x.start, x.end]), [["A1", 0, 2], ["A2", 2, 4.5]]);
  assert.deepEqual(r.hits.map((h: { pad: number; stem: string; start: number }) => [h.pad, h.stem, h.start]), [[0, "kick", 0], [1, "ungrouped", 0.5]]);
});

test("render.wav plays the mix or one stem; unknown stems are 404", async () => {
  const s = await start();
  const q = encodeURIComponent(JSON.stringify(req));
  const mix = (await call(s, `/api/render.wav?req=${q}`)).body as Buffer;
  assert.equal(mix.length, 44 + 4.5 * 48000 * 4);
  assert.equal((await call(s, `/api/render.wav?req=${q}&stem=kick`)).status, 200);
  assert.equal((await call(s, `/api/render.wav?req=${q}&stem=nope`)).status, 404);
});

test("previews are scaled down instead of clipping", async () => {
  const hot = writeProject(tempDir(), { samples: [{ pad: 0, left: dc(1000, 0.9) }, { pad: 1, left: dc(1000, 0.9) }], patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 0, pad: 1 }] }] });
  const s = await start();
  const wav = (await call(s, `/api/render.wav?req=${encodeURIComponent(JSON.stringify({ dir: hot, sequence: [1], groups: {}, tail: "cut" }))}`)).body as Buffer;
  let peak = 0;
  for (let o = 44; o < wav.length; o += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(o)));
  assert.ok(peak < 32767 && peak > 30000, `peak ${peak}`);
});

test("export writes float WAV stems (and the mix) into project/label folders", async () => {
  const s = await start();
  const r = (await call(s, "/api/export", { ...req, outDir, label: "A1: verse/1", includeMix: true })).body;
  assert.equal(r.dest, path.join(outDir, "DEMO", "A1_ verse_1"));
  assert.deepEqual(r.written.map((f: string) => path.basename(f)).sort(), ["_mix.wav", "kick.wav", "ungrouped.wav"]);
  const kick = fs.readFileSync(path.join(r.dest, "kick.wav"));
  assert.equal(kick.readUInt16LE(20), 3);
  assert.equal(kick.readUInt32LE(40), 4.5 * 48000 * 8);
});

test("refactor plan and execution, next to the source project", async () => {
  const s = await start();
  const plan = (await call(s, "/api/refactor/plan", { dir: projectDir, sequence: [1, 2], groups: { kick: [0] } })).body;
  assert.deepEqual(plan.stems.map((x: { stem: string }) => x.stem), ["kick", "Pads in no stem"]);
  const done = (await call(s, "/api/refactor", { dir: projectDir, sequence: [1, 2], groups: { kick: [0] }, name: "P2_SPLIT", chainNumber: 0 })).body;
  assert.equal(done.dest, path.join(path.dirname(projectDir), "P2_SPLIT"));
  assert.ok(fs.existsSync(path.join(done.dest, "PTN", "PATTERNCHAIN_00.CHN")));
  const again = await call(s, "/api/refactor", { dir: projectDir, sequence: [1, 2], groups: { kick: [0] }, name: "P2_SPLIT" });
  assert.equal(again.status, 500);
  assert.match(again.body.error, /already exists/);
});

test("reveal hands the path to the desktop", async () => {
  const s = await start();
  await call(s, `/api/reveal?path=${encodeURIComponent(outDir)}`);
  assert.equal(revealed[revealed.length - 1], outDir);
});

test("device: lists the unit's projects, or says none is connected", async () => {
  const s = await start();
  assert.deepEqual((await call(s, "/api/device")).body, { connected: true, projects: [{ slot: 7, name: "ON THE UNIT", folder: "P7_ON THE UNIT" }] });
  deviceConnected = false;
  try {
    const off = await start();
    assert.deepEqual((await call(off, "/api/device")).body, { connected: false });
  } finally {
    deviceConnected = true;
  }
});

test("device: copies a project, reporting progress, then it opens like any other", async () => {
  const s = await start();
  let job = (await call(s, "/api/device/copy", { slot: 7 })).body;
  assert.equal(job.state, "running");
  while (job.state === "running") {
    await new Promise((r) => setTimeout(r, 20));
    job = (await call(s, `/api/device/job?id=${job.id}`)).body;
  }
  assert.equal(job.state, "done", job.error);
  assert.equal(job.dest, path.join(deviceDir, "P7_ON THE UNIT"));
  assert.equal(job.progress.bytes, job.progress.totalBytes);
  const p = (await call(s, `/api/project?dir=${encodeURIComponent(job.dest)}`)).body;
  assert.equal(p.name, "ON THE UNIT");
  assert.equal(p.pads[3].hasSample, true);
});

test("device: copies to another folder when asked", async () => {
  const s = await start();
  const elsewhere = tempDir();
  let job = (await call(s, "/api/device/copy", { slot: 7, dest: elsewhere })).body;
  while (job.state === "running") {
    await new Promise((r) => setTimeout(r, 20));
    job = (await call(s, `/api/device/job?id=${job.id}`)).body;
  }
  assert.equal(job.dest, path.join(elsewhere, "P7_ON THE UNIT"));
});

test("device: bad slots and unknown jobs are rejected", async () => {
  const s = await start();
  assert.equal((await call(s, "/api/device/copy", { slot: 0 })).status, 400);
  assert.equal((await call(s, "/api/device/copy", { slot: 17 })).status, 400);
  assert.equal((await call(s, "/api/device/job?id=12345")).status, 404);
});

test("device: a missing project slot fails the copy with a message", async () => {
  const s = await start();
  let job = (await call(s, "/api/device/copy", { slot: 2 })).body;
  while (job.state === "running") {
    await new Promise((r) => setTimeout(r, 20));
    job = (await call(s, `/api/device/job?id=${job.id}`)).body;
  }
  assert.equal(job.state, "failed");
  assert.match(job.error, /PROJECT_02/);
});
