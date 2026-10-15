import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enc7, dec7, request, Cmd, openRequest, openDirRequest, readRequest, readDirRequest, closeRequest, fstatRequest,
  frame, connectFrame, FrameParser, parseReply, parseDirEntry, parseStat, remotePath, projectDir, MAX_READ,
} from "../src/sp404/remote/protocol.js";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

test("7-bit groups round-trip positive, negative and pointer-like values", () => {
  for (const v of [0, 1, 127, 128, 0x3fff, 52000, 0x55000, 0x7fffffff, -1, -2143039968, 0x80438000 | 0]) {
    const b = Buffer.from(enc7(v));
    assert.equal(b.length, 5);
    assert.ok(b.every((x) => x < 0x80), "every group is 7-bit");
    assert.equal(dec7(b, 0), v | 0, `value ${v}`);
  }
});

test("7-bit groups are most-significant first", () => {
  assert.deepEqual(enc7(52000), [0, 0, 3, 22, 32]);
  assert.deepEqual(enc7(-1), [0x0f, 0x7f, 0x7f, 0x7f, 0x7f]);
});

test("dec7 ignores flag bits above the top 4 bits of the first group", () => {
  assert.equal(dec7(Buffer.from([0x40, 0, 0, 0x56, 0x20]), 0) & 0x0fffffff, 0x56 * 128 + 0x20);
});

test("requests have the SysEx-style layout the app sends", () => {
  // CEmuFile::RFSClose: F0 41 7A 03 03 <fd> <0> 00 F7 — 17 bytes.
  assert.deepEqual(closeRequest(367), hex("f0417a03 03 000000026f 0000000000 00 f7"));
  assert.equal(closeRequest(1).length, 17);
  assert.equal(fstatRequest(5)[4], Cmd.FStat);
  assert.equal(readDirRequest(-2143039968)[4], Cmd.ReadDir);
  assert.equal(dec7(readDirRequest(-2143039968), 5), -2143039968);
});

test("open sends the path with its NUL and the length including it", () => {
  const path = "/SP404REMOTE///ROLAND/SP-404MKII/PROJECT_01/PADCONF.BIN";
  const m = openRequest(path);
  assert.deepEqual([...m.subarray(0, 5)], [0xf0, 0x41, 0x7a, 0x03, Cmd.Open]);
  assert.equal(dec7(m, 5), 0, "mode 0 = read");
  assert.equal(dec7(m, 10), path.length + 1);
  assert.equal(m.subarray(15, 15 + path.length).toString("latin1"), path);
  assert.equal(m[15 + path.length], 0);
  assert.equal(m[m.length - 1], 0xf7);
  assert.equal(m.length, path.length + 0x11);
});

test("opendir sends the path without a NUL", () => {
  const path = "/SP404REMOTE///ROLAND";
  const m = openDirRequest(path);
  assert.equal(dec7(m, 10), path.length);
  assert.equal(m.length, path.length + 0x10);
  assert.equal(m[15 + path.length], 0xf7);
});

test("reads over 1 KB set the app's flag bit, which leaves the length intact", () => {
  const small = readRequest(7, 0x3ff);
  assert.equal(small[10], 0);
  const big = readRequest(7, MAX_READ);
  assert.equal(big[10], 0x20);
  assert.equal(dec7(big, 10) & 0x0fffffff, MAX_READ);
  assert.equal(dec7(big, 5), 7);
});

test("request() takes an extra byte or a payload", () => {
  assert.equal(request(Cmd.Seek, 1, 100, 2)[15], 2);
  assert.deepEqual([...request(Cmd.Remove, 0, 3, Buffer.from("ab\0")).subarray(15, 18)], [0x61, 0x62, 0]);
});

test("long frames: 12-byte header, little-endian length, payload", () => {
  const f = frame(Buffer.from([1, 2, 3]));
  assert.deepEqual([...f.subarray(0, 4)], [0x13, 0x60, 0xe0, 0x06]);
  assert.equal(f.readUInt32LE(12), 3);
  assert.deepEqual([...f.subarray(16)], [1, 2, 3]);
});

test("the connect frame matches the app's keep-alive message", () => {
  assert.deepEqual(connectFrame(), hex("1260e005 fe670000 00000003"));
});

test("frame parser reassembles frames split at every possible point", () => {
  const a = frame(Buffer.from("hello"));
  const b = connectFrame();
  const c = frame(Buffer.alloc(0));
  const stream = Buffer.concat([a, b, c]);
  for (let cut = 0; cut <= stream.length; cut++) {
    const p = new FrameParser();
    const frames = [...p.push(stream.subarray(0, cut)), ...p.push(stream.subarray(cut))];
    assert.equal(frames.length, 3, `cut at ${cut}`);
    assert.equal(frames[0].payload.toString(), "hello");
    assert.deepEqual([...frames[1].payload], [0xfe, 0x67, 0]);
    assert.equal(frames[2].payload.length, 0);
  }
});

test("frame parser handles byte-at-a-time delivery", () => {
  const stream = Buffer.concat([frame(Buffer.alloc(300, 7)), frame(Buffer.from([9]))]);
  const p = new FrameParser();
  const frames = [...stream].flatMap((byte) => p.push(Buffer.from([byte])));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.length, 300);
});

// Replies captured from a real SP-404MKII (firmware 5.52).
test("parses a captured connect reply", () => {
  const p = new FrameParser();
  const [f] = p.push(Buffer.concat([hex("13e00005f424e08248b25b83"), Buffer.from([19, 0, 0, 0]), hex("7e04000900 0d0000ffffffff0002010000 0b33")]));
  assert.equal(parseReply(f.payload).kind, "connected");
});

test("parses a captured failure result (value 0, errno 22)", () => {
  assert.deepEqual(parseReply(hex("f0417a7a 0000000000 0000000016 f7")), { kind: "result", value: 0, errno: 22 });
});

test("parses a captured negative result and a directory handle", () => {
  assert.deepEqual(parseReply(hex("f0417a7a 0f7f7f7f7f 0000000008 f7")), { kind: "result", value: -1, errno: 8 });
  const handle = -2143039968;
  const r = parseReply(Buffer.from([0xf0, 0x41, 0x7a, 0x7a, ...enc7(handle), ...enc7(2), 0xf7]));
  assert.deepEqual(r, { kind: "result", value: handle, errno: 2 });
});

test("parses data packets, including the last-packet flag", () => {
  const body = Buffer.alloc(11040, 0xab);
  const last = parseReply(Buffer.concat([hex("f0417a02 0000000261 40000056 20"), body, hex("f7")]));
  assert.equal(last.kind, "data");
  if (last.kind === "data") {
    assert.equal(last.last, true);
    assert.equal(last.data.length, 11040);
  }
  const more = parseReply(Buffer.concat([Buffer.from([0xf0, 0x41, 0x7a, 0x02, 0, 0, 0, 0, 0, ...enc7(4)]), Buffer.from("abcd"), Buffer.from([0xf7])]));
  assert.deepEqual(more.kind === "data" && [more.last, more.data.toString()], [false, "abcd"]);
});

test("parses busy messages and requests from the unit", () => {
  assert.deepEqual(parseReply(hex("f0417a7cf7")), { kind: "busy" });
  assert.deepEqual(parseReply(request(Cmd.Write, 1, 2)), { kind: "request", cmd: Cmd.Write });
  assert.equal(parseReply(Buffer.from([1, 2, 3])).kind, "other");
});

test("parses captured directory entries", () => {
  assert.deepEqual(parseDirEntry(Buffer.concat([hex("000000000a04"), Buffer.from("PROJECT_01\0")])), { name: "PROJECT_01", isDir: true });
  assert.deepEqual(parseDirEntry(Buffer.concat([hex("000000000c08"), Buffer.from("DOOMBOOT.DAT\0")])), { name: "DOOMBOOT.DAT", isDir: false });
  // Without a length byte, the name runs to the NUL.
  assert.deepEqual(parseDirEntry(Buffer.concat([hex("000000000008"), Buffer.from("A.BIN\0junk")])), { name: "A.BIN", isDir: false });
});

test("parses a captured fstat reply (PADCONF.BIN, 52000 bytes)", () => {
  assert.deepEqual(parseStat(hex("ff810000 20cb0000")), { isDir: false, size: 52000 });
  assert.equal(parseStat(hex("ff410000 00000000")).isDir, true);
});

test("remote paths: the prefix, then an absolute path (three slashes in a row)", () => {
  assert.equal(remotePath("/ROLAND/SP-404MKII"), "/SP404REMOTE///ROLAND/SP-404MKII");
  assert.equal(remotePath("ROLAND"), "/SP404REMOTE///ROLAND");
  assert.equal(projectDir(1), "/ROLAND/SP-404MKII/PROJECT_01");
  assert.equal(projectDir(16), "/ROLAND/SP-404MKII/PROJECT_16");
});
