// A pretend SP-404MKII for tests: speaks the USB file protocol, serving a folder on disk as its
// internal storage (the folder plays the part of "/" on the unit).
import * as fs from "fs";
import * as path from "path";
import { FrameParser, Cmd, enc7, dec7 } from "../../src/sp404/remote/protocol.js";
import { Transport } from "../../src/sp404/remote/device.js";

export interface FakeOptions {
  packetSize?: number; // data bytes per packet
  chunkSize?: number; // split what the unit sends into pieces this big (tests stream reassembly)
  busyEvery?: number; // send a "busy" message before every Nth reply
  silentAfter?: number; // stop answering after this many requests (simulates unplugging)
  failRead?: string; // files whose path contains this fail after their first chunk
}

const REPLY_HEADER = [0x13, 0xe0, 0x60, 0x06];
const CONNECT_HEADER = [0x13, 0xe0, 0x00, 0x05];
// What a real unit answered to the connect message.
export const CONNECT_REPLY = Buffer.from([0x7e, 0x04, 0x00, 0x09, 0x00, 0x0d, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 2, 1, 0, 0, 0x0b, 0x33]);

export class FakeSp404 implements Transport {
  private parser = new FrameParser();
  private listeners: ((chunk: Buffer) => void)[] = [];
  private files = new Map<number, { fd: number; path: string; pos: number }>();
  private dirs = new Map<number, { entries: fs.Dirent[]; pos: number }>();
  private nextFd = 300;
  private nextDir = 0x80438000 | 0; // the real unit hands out directory handles like this (negative as int32)
  requests: { cmd: number; a: number; b: number; path?: string }[] = [];
  closed = false;
  connects = 0;

  constructor(readonly root: string, private opts: FakeOptions = {}) {}

  // ---- Transport ----
  write(data: Buffer) {
    for (const f of this.parser.push(data)) {
      if (f.header[3] === 0x05 && f.payload[0] === 0xfe && f.payload[1] === 0x67) {
        this.connects++;
        this.emit(CONNECT_HEADER, CONNECT_REPLY);
      } else if (f.payload[0] === 0xf0 && f.payload[3] === 0x03) {
        this.handle(f.payload);
      }
    }
  }
  onData(listener: (chunk: Buffer) => void) {
    this.listeners.push(listener);
  }
  async close() {
    this.closed = true;
  }

  // ---- the unit's side ----
  private emit(header: number[], payload: Buffer) {
    const out = Buffer.alloc(16 + payload.length);
    out.set(header, 0);
    out.set([0x82, 0x48, 0xb2, 0x5b, 0x83], 7); // junk, like the pointer bytes the real unit leaves here
    out.writeUInt32LE(payload.length, 12);
    payload.copy(out, 16);
    const step = this.opts.chunkSize ?? out.length;
    // Deliver asynchronously, like a real port.
    setImmediate(() => {
      for (let i = 0; i < out.length; i += step) for (const l of this.listeners) l(out.subarray(i, i + step));
    });
  }

  private result(value: number, errno = 0) {
    this.emit(REPLY_HEADER, Buffer.from([0xf0, 0x41, 0x7a, 0x7a, ...enc7(value), ...enc7(errno), 0xf7]));
  }

  private data(bytes: Buffer) {
    const size = this.opts.packetSize ?? 0x5000;
    for (let i = 0; i < bytes.length || i === 0; i += size) {
      const part = bytes.subarray(i, i + size);
      const lenBytes = enc7(part.length);
      if (i + size >= bytes.length) lenBytes[0] |= 0x40; // last packet
      this.emit(REPLY_HEADER, Buffer.from([0xf0, 0x41, 0x7a, 0x02, 0, 0, 0, 2, 0x6f, ...lenBytes, ...part, 0xf7]));
      if (!bytes.length) break;
    }
  }

  private local(remote: string): string | undefined {
    const prefix = "/SP404REMOTE//";
    if (!remote.startsWith(prefix)) return undefined;
    const rel = remote.slice(prefix.length);
    // Like the real unit: paths must be absolute after the prefix; no trailing slash except "/".
    if (!rel.startsWith("/") || (rel.length > 1 && rel.endsWith("/"))) return undefined;
    const p = path.join(this.root, rel);
    return p.startsWith(this.root) ? p : undefined;
  }

  private handle(p: Buffer) {
    const cmd = p[4];
    const a = dec7(p, 5);
    const b = dec7(p, 10);
    const tail = p.subarray(15, p.length - 1);
    const strArg = () => tail.toString("latin1").replace(/\0.*$/s, "");
    const req = { cmd, a, b, path: cmd === Cmd.Open || cmd === Cmd.OpenDir ? strArg() : undefined };
    this.requests.push(req);
    if (this.opts.silentAfter !== undefined && this.requests.length > this.opts.silentAfter) return;
    if (this.opts.busyEvery && this.requests.length % this.opts.busyEvery === 0) {
      this.emit(REPLY_HEADER, Buffer.from([0xf0, 0x41, 0x7a, 0x7c, 0xf7]));
    }
    switch (cmd) {
      case Cmd.OpenDir: {
        const dir = this.local(strArg());
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return this.result(0, 22);
        const h = this.nextDir++;
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("._"));
        // The real unit lists "." and ".." in subfolders.
        const dots = dir !== this.root ? [{ name: ".", isDirectory: () => true }, { name: "..", isDirectory: () => true }] as fs.Dirent[] : [];
        this.dirs.set(h, { entries: [...dots, ...entries], pos: 0 });
        return this.result(h, 0);
      }
      case Cmd.ReadDir: {
        const d = this.dirs.get(a);
        if (!d || d.pos >= d.entries.length) return this.result(-1, 2);
        const e = d.entries[d.pos++];
        const name = Buffer.from(e.name, "latin1");
        return this.data(Buffer.concat([Buffer.from([0, 0, 0, 0, name.length, e.isDirectory() ? 4 : 8]), name, Buffer.alloc(1)]));
      }
      case Cmd.CloseDir:
        this.dirs.delete(a);
        return this.result(0);
      case Cmd.Open: {
        const file = this.local(strArg());
        if (a !== 0) return this.result(-1, 13); // this fake is read-only
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return this.result(-1, 2);
        const fd = this.nextFd++;
        this.files.set(fd, { fd, path: file, pos: 0 });
        return this.result(fd, 2);
      }
      case Cmd.FStat: {
        const f = this.files.get(a);
        if (!f) return this.result(-1, 9);
        const st = Buffer.alloc(8);
        st.writeUInt32LE(0x81ff, 0);
        st.writeUInt32LE(fs.statSync(f.path).size, 4);
        return this.data(st);
      }
      case Cmd.Read: {
        const f = this.files.get(a);
        if (!f) return this.result(-1, 9);
        if (this.opts.failRead && f.path.includes(this.opts.failRead) && f.pos > 0) return this.result(-1, 5);
        const all = fs.readFileSync(f.path);
        const chunk = all.subarray(f.pos, f.pos + b);
        if (!chunk.length) return this.result(0, 8);
        f.pos += chunk.length;
        return this.data(chunk);
      }
      case Cmd.Close:
        this.files.delete(a);
        return this.result(0, 8);
      default:
        return this.result(-1, 38); // anything that would change the unit: refuse
    }
  }
}
