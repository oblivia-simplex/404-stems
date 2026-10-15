// Wire format of the SP-404MKII's USB serial link, as used by Roland's SP-404MKII app to reach
// the unit's internal storage. See docs/sp404mk2-project-format.md ("USB file access").
//
// Every message is a frame: a 12-byte header, then (for long frames) a little-endian u32 length
// and that many payload bytes. Short frames carry up to 7 payload bytes inside the header.
// File-system traffic uses long frames whose payload looks like Roland SysEx:
//   F0 41 7A <type> ... F7
// Requests (type 03) carry a command byte, two 35-bit arguments written as five 7-bit groups,
// then either a path or one extra byte. Replies are results (type 7A: two 7-bit-group values),
// data packets (type 02) or "busy, keep waiting" (type 7C).

export const REMOTE_PREFIX = "/SP404REMOTE//";
// Internal storage holds one folder per project slot, laid out like a project exported to SD.
export const PROJECTS_DIR = "/ROLAND/SP-404MKII";
export const PROJECT_SLOTS = 16;
export const MAX_READ = 0x55000; // largest read the app asks for in one request

export const ROLAND_VENDOR_ID = 0x0582;
export const SERIAL_PRODUCT_ID = 0x02e7;

export enum Cmd {
  Open = 0x00,
  Close = 0x03,
  Read = 0x04,
  Write = 0x06,
  Seek = 0x07,
  Remove = 0x0a,
  OpenDir = 0x0c,
  CloseDir = 0x0d,
  ReadDir = 0x0e,
  FStat = 0x13,
}

export enum OpenMode {
  Read = 0,
}

const SYSEX_HEAD = [0xf0, 0x41, 0x7a];
const TYPE_REQUEST = 0x03;
const TYPE_DATA = 0x02;
const TYPE_RESULT = 0x7a;
const TYPE_BUSY = 0x7c;
const LAST_PACKET = 0x40; // bit in the first length byte of a data packet

const HEADER_SIZE = 12;
const LONG_FLAG = 0x01;
// Header bytes of the frames the app sends: message id, source and destination addresses, class.
const LONG_HEADER = [0x13, 0x60, 0xe0, 0x06];
const CONNECT_HEADER = [0x12, 0x60, 0xe0, 0x05];
// Every reply to a connect request ends with this byte; the app ignores replies without it.
const CONNECT_REPLY_MAGIC = 0x33;

/** Write a 32-bit value as five 7-bit groups, most significant first. */
export function enc7(value: number): number[] {
  const v = value >>> 0;
  return [(v >>> 28) & 0x0f, (v >>> 21) & 0x7f, (v >>> 14) & 0x7f, (v >>> 7) & 0x7f, v & 0x7f];
}

/** Read five 7-bit groups as a signed 32-bit value (the top group only contributes 4 bits). */
export function dec7(buf: Uint8Array, offset: number): number {
  return (((buf[offset] & 0x0f) << 28) | (buf[offset + 1] << 21) | (buf[offset + 2] << 14) | (buf[offset + 3] << 7) | buf[offset + 4]) | 0;
}

/** A file-system request: F0 41 7A 03 <cmd> <a: 5 groups> <b: 5 groups> <payload or extra byte> F7. */
export function request(cmd: Cmd, a: number, b: number, payload?: Uint8Array | number): Buffer {
  const tail = payload === undefined ? [0] : typeof payload === "number" ? [payload & 0xff] : [...payload];
  return Buffer.from([...SYSEX_HEAD, TYPE_REQUEST, cmd, ...enc7(a), ...enc7(b), ...tail, 0xf7]);
}

const cString = (s: string) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.alloc(1)]);

export const openRequest = (path: string, mode = OpenMode.Read) => {
  const p = cString(path);
  return request(Cmd.Open, mode, p.length, p);
};
// The app sends directory paths without a terminating NUL.
export const openDirRequest = (path: string) => request(Cmd.OpenDir, 0, path.length, Buffer.from(path, "latin1"));
export const readDirRequest = (dir: number) => request(Cmd.ReadDir, dir, 0);
export const closeDirRequest = (dir: number) => request(Cmd.CloseDir, dir, 0);
export const fstatRequest = (fd: number) => request(Cmd.FStat, fd, 0);
export const closeRequest = (fd: number) => request(Cmd.Close, fd, 0);
export function readRequest(fd: number, length: number): Buffer {
  const msg = request(Cmd.Read, fd, length);
  // The app sets this flag in the length's top group for reads over 1 KB.
  if (length > 0x3ff) msg[10] |= 0x20;
  return msg;
}

/** Wrap a SysEx-style message in a long frame. */
export function frame(payload: Uint8Array): Buffer {
  const out = Buffer.alloc(HEADER_SIZE + 4 + payload.length);
  out.set(LONG_HEADER, 0);
  out.writeUInt32LE(payload.length, HEADER_SIZE);
  out.set(payload, HEADER_SIZE + 4);
  return out;
}

/** The short frame the app sends to open (and keep alive) a session. */
export function connectFrame(mode = 0): Buffer {
  const out = Buffer.alloc(HEADER_SIZE);
  out.set(CONNECT_HEADER, 0);
  out.set([0xfe, 0x67, mode & 0xff], 4);
  out[11] = 3;
  return out;
}

export interface Frame {
  header: Buffer;
  payload: Buffer;
}

/** Splits a byte stream into frames; chunks may end anywhere. */
export class FrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: Frame[] = [];
    for (;;) {
      if (this.buf.length < HEADER_SIZE) break;
      const header = this.buf.subarray(0, HEADER_SIZE);
      if (header[0] & LONG_FLAG) {
        if (this.buf.length < HEADER_SIZE + 4) break;
        const n = this.buf.readUInt32LE(HEADER_SIZE);
        if (this.buf.length < HEADER_SIZE + 4 + n) break;
        out.push({ header: Buffer.from(header), payload: Buffer.from(this.buf.subarray(HEADER_SIZE + 4, HEADER_SIZE + 4 + n)) });
        this.buf = this.buf.subarray(HEADER_SIZE + 4 + n);
      } else {
        out.push({ header: Buffer.from(header), payload: Buffer.from(header.subarray(4, 4 + Math.min(header[11], 7))) });
        this.buf = this.buf.subarray(HEADER_SIZE);
      }
    }
    return out;
  }
}

export type Reply =
  | { kind: "result"; value: number; errno: number }
  | { kind: "data"; data: Buffer; last: boolean }
  | { kind: "busy" }
  | { kind: "request"; cmd: number }
  | { kind: "connected"; payload: Buffer }
  | { kind: "other"; payload: Buffer };

export function parseReply(payload: Buffer): Reply {
  if (payload.length >= 4 && payload[0] === 0xf0 && payload[1] === 0x41 && payload[2] === 0x7a) {
    switch (payload[3]) {
      case TYPE_RESULT:
        return { kind: "result", value: dec7(payload, 4), errno: dec7(payload, 9) };
      case TYPE_DATA: {
        const n = dec7(payload, 9) & 0x0fffffff;
        return { kind: "data", data: payload.subarray(14, 14 + n), last: (payload[9] & LAST_PACKET) !== 0 };
      }
      case TYPE_BUSY:
        return { kind: "busy" };
      case TYPE_REQUEST:
        return { kind: "request", cmd: payload[4] };
    }
  }
  if (payload.length && payload[payload.length - 1] === CONNECT_REPLY_MAGIC) return { kind: "connected", payload };
  return { kind: "other", payload };
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

/** Directory entry data: 4 unknown bytes, name length, type (4 = folder, 8 = file), then the name. */
export function parseDirEntry(data: Buffer): DirEntry {
  const len = data[4];
  const end = data.indexOf(0, 6);
  const name = data.subarray(6, len ? 6 + len : end < 0 ? data.length : end).toString("latin1");
  return { name, isDir: data[5] === 4 };
}

export interface Stat {
  isDir: boolean;
  size: number;
}

/** fstat data: u32 mode, u32 size, little-endian. */
export function parseStat(data: Buffer): Stat {
  return { isDir: (data.readUInt32LE(0) & 0xf000) === 0x4000, size: data.readUInt32LE(4) };
}

/** Path on the device, as the app writes it: the remote prefix, then an absolute path. */
export const remotePath = (absolute: string) => REMOTE_PREFIX + (absolute.startsWith("/") ? absolute : "/" + absolute);
export const projectDir = (slot: number) => `${PROJECTS_DIR}/PROJECT_${String(slot).padStart(2, "0")}`;
