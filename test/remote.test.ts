import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Sp404Device, DeviceError } from "../src/sp404/remote/device.js";
import { listProjects, listProjectFiles, downloadProject, localFolderName, projectNameFromHeader } from "../src/sp404/remote/projects.js";
import { DeviceLink } from "../src/sp404/remote/session.js";
import { Cmd } from "../src/sp404/remote/protocol.js";
import { loadProject } from "../src/sp404/project.js";
import { FakeSp404, FakeOptions } from "./support/fakeSp404.js";
import { tempDir, writeProject, dc } from "./support/fixtures.js";

const FAST = { reply: 300, busy: 600 };

/** A unit with projects in slots 1, 2 and 5 (2 is unnamed), each with samples and patterns. */
function makeUnit(): string {
  const root = tempDir("sp404-unit-");
  const base = path.join(root, "ROLAND", "SP-404MKII");
  writeProject(path.join(base, "PROJECT_01"), {
    name: "FIRST",
    samples: [{ pad: 0, left: dc(1000) }, { pad: 17, left: dc(70000, 0.25), right: dc(70000, -0.25) }],
    patterns: [{ number: 1, notes: [{ tick: 0, pad: 0 }, { tick: 480, pad: 17 }] }],
    chains: [{ number: 0, patterns: [1, 1] }],
    extraFiles: { "PICTURE/A.BMP": Buffer.alloc(300, 1) },
  });
  writeProject(path.join(base, "PROJECT_02"), { name: "", samples: [{ pad: 3, left: dc(10) }] });
  writeProject(path.join(base, "PROJECT_05"), { name: "VOO/DOO", patterns: [{ number: 2, notes: [] }] });
  fs.mkdirSync(path.join(base, "PROJECT_03")); // a slot with no PADCONF: treated as empty
  fs.writeFileSync(path.join(base, "QSPI.bin"), "x");
  return root;
}

function connect(unit: string, opts: FakeOptions = {}) {
  const fake = new FakeSp404(unit, opts);
  return { fake, dev: new Sp404Device(fake, FAST) };
}

function sameTree(a: string, b: string) {
  const walk = (d: string, rel = ""): string[] =>
    fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(d, path.join(rel, e.name)) : [path.join(rel, e.name)],
    );
  const fa = walk(a).sort();
  assert.deepEqual(fa, walk(b).sort());
  for (const f of fa) assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), `${f} differs`);
}

test("connect gets the unit's status reply", async () => {
  const { dev, fake } = connect(makeUnit());
  const reply = await dev.connect();
  assert.equal(reply[reply.length - 1], 0x33);
  assert.equal(fake.connects, 1);
});

test("lists folders, skipping . and ..", async () => {
  const { dev } = connect(makeUnit());
  const names = (await dev.list("/ROLAND/SP-404MKII")).map((e) => `${e.name}${e.isDir ? "/" : ""}`).sort();
  assert.deepEqual(names, ["PROJECT_01/", "PROJECT_02/", "PROJECT_03/", "PROJECT_05/", "QSPI.bin"]);
});

test("directory handles that are negative as int32 work (the real unit uses them)", async () => {
  const { dev, fake } = connect(makeUnit());
  await dev.list("/ROLAND");
  const rd = fake.requests.find((r) => r.cmd === Cmd.ReadDir)!;
  assert.ok(rd.a < 0);
  assert.ok(fake.requests.some((r) => r.cmd === Cmd.CloseDir && r.a === rd.a), "directory is closed");
});

test("a missing folder is an error naming it", async () => {
  const { dev } = connect(makeUnit());
  await assert.rejects(dev.list("/NOPE"), (e: DeviceError) => e instanceof DeviceError && /NOPE/.test(e.message) && e.errno === 22);
});

test("reads files exactly, across many data packets", async () => {
  const unit = makeUnit();
  const { dev } = connect(unit, { packetSize: 1000 });
  const want = fs.readFileSync(path.join(unit, "ROLAND/SP-404MKII/PROJECT_01/SMPL/BANK2-02.SMP"));
  const progress: number[] = [];
  const got = await dev.readFile("/ROLAND/SP-404MKII/PROJECT_01/SMPL/BANK2-02.SMP", (n) => progress.push(n));
  assert.ok(got.equals(want));
  assert.equal(progress[progress.length - 1], want.length);
  assert.ok(progress.every((n, i) => i === 0 || n > progress[i - 1]), "progress only goes up");
});

test("large files are read in requests of at most 0x55000 bytes", async () => {
  const unit = makeUnit();
  const big = Buffer.alloc(0x55000 * 2 + 123);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  fs.writeFileSync(path.join(unit, "BIG.BIN"), big);
  const { dev, fake } = connect(unit);
  assert.ok((await dev.readFile("/BIG.BIN")).equals(big));
  const reads = fake.requests.filter((r) => r.cmd === Cmd.Read);
  assert.equal(reads.length, 3);
  assert.ok(reads.every((r) => (r.b & 0x0fffffff) <= 0x55000));
  assert.ok(fake.requests.some((r) => r.cmd === Cmd.Close), "file is closed");
});

test("readFile with a limit only fetches what's needed", async () => {
  const { dev, fake } = connect(makeUnit());
  const head = await dev.readFile("/ROLAND/SP-404MKII/PROJECT_01/PADCONF.BIN", undefined, 0xa0);
  assert.equal(head.length, 0xa0);
  assert.equal(head.toString("latin1", 0, 4), "RFPD");
  assert.equal(fake.requests.filter((r) => r.cmd === Cmd.Read).length, 1);
});

test("empty files read as empty", async () => {
  const unit = makeUnit();
  fs.writeFileSync(path.join(unit, "EMPTY"), "");
  const { dev } = connect(unit);
  assert.equal((await dev.readFile("/EMPTY")).length, 0);
});

test("stat reports sizes", async () => {
  const unit = makeUnit();
  const { dev } = connect(unit);
  assert.deepEqual(await dev.stat("/ROLAND/SP-404MKII/PROJECT_01/PADCONF.BIN"), { isDir: false, size: 52000 });
});

test("a missing file is an error naming it, and nothing is left open", async () => {
  const { dev, fake } = connect(makeUnit());
  await assert.rejects(dev.readFile("/ROLAND/NOPE.BIN"), /NOPE\.BIN/);
  assert.equal(fake.requests.filter((r) => r.cmd === Cmd.Close).length, 0, "no handle to close");
});

test("survives replies split into tiny chunks", async () => {
  const unit = makeUnit();
  const { dev } = connect(unit, { chunkSize: 3, packetSize: 777 });
  const want = fs.readFileSync(path.join(unit, "ROLAND/SP-404MKII/PROJECT_01/PADCONF.BIN"));
  assert.ok((await dev.readFile("/ROLAND/SP-404MKII/PROJECT_01/PADCONF.BIN")).equals(want));
});

test("busy messages extend the wait instead of failing", async () => {
  const { dev } = connect(makeUnit(), { busyEvery: 2 });
  assert.equal((await dev.list("/ROLAND/SP-404MKII")).length, 5);
});

test("a unit that stops answering gives a clear error instead of hanging", async () => {
  const { dev } = connect(makeUnit(), { silentAfter: 3 });
  await assert.rejects(dev.list("/ROLAND/SP-404MKII"), /stopped responding/);
});

test("concurrent calls are serialised (replies carry no request id)", async () => {
  const unit = makeUnit();
  const { dev } = connect(unit, { chunkSize: 5 });
  const [a, b, c] = await Promise.all([
    dev.readFile("/ROLAND/SP-404MKII/PROJECT_01/PADCONF.BIN"),
    dev.list("/ROLAND"),
    dev.readFile("/ROLAND/SP-404MKII/PROJECT_02/PADCONF.BIN"),
  ]);
  assert.ok(a.equals(fs.readFileSync(path.join(unit, "ROLAND/SP-404MKII/PROJECT_01/PADCONF.BIN"))));
  assert.deepEqual(b.map((e) => e.name), ["SP-404MKII"]);
  assert.ok(c.equals(fs.readFileSync(path.join(unit, "ROLAND/SP-404MKII/PROJECT_02/PADCONF.BIN"))));
});

test("a failed call doesn't block the ones after it", async () => {
  const { dev } = connect(makeUnit());
  const results = await Promise.allSettled([dev.readFile("/MISSING"), dev.list("/ROLAND")]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
});

test("only read-only commands are ever sent", async () => {
  const unit = makeUnit();
  const { dev, fake } = connect(unit);
  const dest = tempDir();
  await listProjects(dev);
  await downloadProject(dev, 1, dest);
  const allowed = new Set([Cmd.Open, Cmd.Close, Cmd.Read, Cmd.FStat, Cmd.OpenDir, Cmd.ReadDir, Cmd.CloseDir]);
  assert.ok(fake.requests.every((r) => allowed.has(r.cmd)), "no write, seek or remove");
  assert.ok(fake.requests.filter((r) => r.cmd === Cmd.Open).every((r) => r.a === 0), "files opened read-only");
});

// ---- projects ----

test("project names come from the PADCONF header", () => {
  const h = Buffer.alloc(0xa0);
  h.write("HITCHHIKERS                    \0", 0x80, "latin1");
  assert.equal(projectNameFromHeader(h), "HITCHHIKERS");
});

test("local folder names follow the unit's SD export style and are filesystem-safe", () => {
  assert.equal(localFolderName(3, "HITCHHIKERS"), "P3_HITCHHIKERS");
  assert.equal(localFolderName(12, ""), "P12_PROJECT_12");
  assert.equal(localFolderName(5, "VOO/DOO:1"), "P5_VOO_DOO_1");
});

test("lists the projects on the unit, skipping empty slots", async () => {
  const { dev } = connect(makeUnit());
  assert.deepEqual(await listProjects(dev), [
    { slot: 1, name: "FIRST", folder: "P1_FIRST" },
    { slot: 2, name: "", folder: "P2_PROJECT_02" },
    { slot: 5, name: "VOO/DOO", folder: "P5_VOO_DOO" },
  ]);
});

test("lists every file in a project with its size", async () => {
  const { dev } = connect(makeUnit());
  const files = await listProjectFiles(dev, 1);
  assert.deepEqual(files.map((f) => f.rel).sort(), [
    "PADCONF.BIN", "PICTURE/A.BMP", "PTN/PATTERNCHAIN_00.CHN", "PTN/PTN00001.BIN", "SMPL/BANK1-01.SMP", "SMPL/BANK2-02.SMP",
  ]);
  assert.equal(files.find((f) => f.rel === "PADCONF.BIN")!.size, 52000);
});

test("downloads a project byte-for-byte, and it loads like an SD export", async () => {
  const unit = makeUnit();
  const { dev } = connect(unit, { packetSize: 4096 });
  const dest = tempDir();
  const progress: { bytes: number; totalBytes: number; filesDone: number; files: number }[] = [];
  const out = await downloadProject(dev, 1, dest, (p) => progress.push(p));
  assert.equal(out, path.join(dest, "P1_FIRST"));
  sameTree(out, path.join(unit, "ROLAND/SP-404MKII/PROJECT_01"));
  const last = progress[progress.length - 1];
  assert.equal(last.bytes, last.totalBytes);
  assert.equal(last.filesDone, last.files);
  const p = loadProject(out);
  assert.equal(p.conf.projectName, "FIRST");
  assert.deepEqual([...p.patterns.keys()], [1]);
  assert.deepEqual(p.chains[0].patterns, [1, 1]);
  assert.ok(p.hasSample[0] && p.hasSample[17]);
});

test("a project with no patterns still gets SMPL and PTN folders", async () => {
  const unit = makeUnit();
  fs.rmSync(path.join(unit, "ROLAND/SP-404MKII/PROJECT_02/PTN"), { recursive: true });
  const { dev } = connect(unit);
  const out = await downloadProject(dev, 2, tempDir());
  assert.ok(fs.existsSync(path.join(out, "PTN")));
  assert.ok(fs.existsSync(path.join(out, "SMPL")));
});

test("downloading again replaces the earlier copy", async () => {
  const unit = makeUnit();
  const dest = tempDir();
  await downloadProject(connect(unit).dev, 1, dest);
  fs.writeFileSync(path.join(dest, "P1_FIRST", "STALE.TXT"), "old");
  fs.rmSync(path.join(unit, "ROLAND/SP-404MKII/PROJECT_01/PICTURE"), { recursive: true });
  const out = await downloadProject(connect(unit).dev, 1, dest);
  sameTree(out, path.join(unit, "ROLAND/SP-404MKII/PROJECT_01"));
  assert.deepEqual(fs.readdirSync(dest), ["P1_FIRST"], "no temporary folders left behind");
});

test("a failed download leaves the earlier copy untouched and no partial folder", async () => {
  const unit = makeUnit();
  const dest = tempDir();
  await downloadProject(connect(unit).dev, 1, dest, undefined);
  const before = fs.readFileSync(path.join(dest, "P1_FIRST", "PADCONF.BIN"));
  const { dev } = connect(unit, { failRead: "BANK2-02", packetSize: 1000 });
  // Make the sample big enough to need a second read request.
  fs.writeFileSync(path.join(unit, "ROLAND/SP-404MKII/PROJECT_01/SMPL/BANK2-02.SMP"), Buffer.alloc(0x55000 + 10));
  await assert.rejects(downloadProject(dev, 1, dest), /BANK2-02/);
  assert.deepEqual(fs.readdirSync(dest), ["P1_FIRST"]);
  assert.ok(fs.readFileSync(path.join(dest, "P1_FIRST", "PADCONF.BIN")).equals(before));
});

test("a download can be cancelled, leaving nothing behind", async () => {
  const unit = makeUnit();
  const dest = tempDir();
  let calls = 0;
  await assert.rejects(downloadProject(connect(unit).dev, 1, dest, undefined, () => ++calls > 2), /cancelled/);
  assert.deepEqual(fs.readdirSync(dest), []);
});

// ---- the server's connection manager ----

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("DeviceLink: no unit connected", async () => {
  const link = new DeviceLink(async () => undefined);
  assert.equal(await link.projects(), undefined);
  const job = link.start(1, tempDir());
  await waitFor(() => job.state !== "running");
  assert.equal(job.state, "failed");
  assert.match(job.error!, /No SP-404MKII found/);
});

test("DeviceLink: lists, copies with progress, then closes the port when idle", async () => {
  const unit = makeUnit();
  const fakes: FakeSp404[] = [];
  const link = new DeviceLink(async () => {
    const f = new FakeSp404(unit);
    fakes.push(f);
    return new Sp404Device(f, FAST);
  }, 50);
  assert.deepEqual((await link.projects())!.map((p) => p.slot), [1, 2, 5]);
  const dest = tempDir();
  const job = link.start(5, dest);
  assert.throws(() => link.start(1, dest), /already being copied/);
  await assert.rejects(link.projects(), /being copied/);
  await waitFor(() => job.state !== "running");
  assert.equal(job.state, "done", job.error);
  assert.equal(job.dest, path.join(dest, "P5_VOO_DOO"));
  assert.equal(link.status(job.id), job);
  assert.equal(link.status(job.id + 1), undefined);
  assert.equal(fakes.length, 1, "one connection reused");
  await waitFor(() => fakes[0].closed);
  await link.projects();
  assert.equal(fakes.length, 2, "reopened after idling");
  await link.close();
});

test("DeviceLink: cancelling a copy", async () => {
  const unit = makeUnit();
  const link = new DeviceLink(async () => new Sp404Device(new FakeSp404(unit, { packetSize: 64 }), FAST), 50);
  const dest = tempDir();
  const job = link.start(1, dest);
  link.stop(job.id);
  await waitFor(() => job.state !== "running");
  assert.equal(job.state, "cancelled");
  assert.deepEqual(fs.readdirSync(dest).filter((f) => !f.startsWith(".")), []);
  await link.close();
});

test("DeviceLink: a unit that disappears is reconnected next time", async () => {
  const unit = makeUnit();
  let opens = 0;
  const link = new DeviceLink(async () => new Sp404Device(new FakeSp404(unit, opens++ === 0 ? { silentAfter: 1 } : {}), FAST), 50);
  await assert.rejects(link.projects(), /stopped responding/);
  assert.equal((await link.projects())!.length, 3);
  assert.equal(opens, 2);
  await link.close();
});
