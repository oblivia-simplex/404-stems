// Client for the SP-404MKII's internal storage over USB serial. Read-only: it only ever sends the
// open, read, stat and directory-listing requests (plus the connect handshake).
import {
  Frame,
  FrameParser,
  Reply,
  DirEntry,
  Stat,
  MAX_READ,
  connectFrame,
  frame,
  parseReply,
  parseDirEntry,
  parseStat,
  openRequest,
  openDirRequest,
  readDirRequest,
  closeDirRequest,
  readRequest,
  fstatRequest,
  closeRequest,
  remotePath,
  ROLAND_VENDOR_ID,
  SERIAL_PRODUCT_ID,
} from "./protocol.js";

/** Anything that moves bytes to and from the unit: the serial port, or a fake in tests. */
export interface Transport {
  write(data: Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  close(): Promise<void>;
}

export class DeviceError extends Error {
  constructor(message: string, readonly errno?: number) {
    super(message);
  }
}

/** The unit didn't answer in time: unplugged, switched off, or busy with something else. */
export class DeviceTimeoutError extends DeviceError {
  constructor() {
    super("The SP-404MKII stopped responding.");
  }
}

// The app waits 2.5 s for a reply, or 10 s once the unit has said it's busy.
const REPLY_TIMEOUT = 2500;
const BUSY_TIMEOUT = 10000;

export class Sp404Device {
  private parser = new FrameParser();
  private queue: Frame[] = [];
  private waiter: (() => void) | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private transport: Transport, private timeouts = { reply: REPLY_TIMEOUT, busy: BUSY_TIMEOUT }) {
    transport.onData((chunk) => {
      this.queue.push(...this.parser.push(chunk));
      this.waiter?.();
    });
  }

  close() {
    return this.transport.close();
  }

  // One request at a time, like the app: replies carry no request id.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async nextReply(timeout: number): Promise<Reply> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const f = this.queue.shift();
      if (f) return parseReply(f.payload);
      const left = deadline - Date.now();
      if (left <= 0) throw new DeviceTimeoutError();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.waiter = undefined;
    }
  }

  // Send one request and gather its reply: a result, or data packets up to the last one.
  private async call(msg: Buffer): Promise<{ result?: { value: number; errno: number }; data: Buffer }> {
    this.queue.length = 0;
    this.transport.write(frame(msg));
    const chunks: Buffer[] = [];
    let timeout = this.timeouts.reply;
    for (;;) {
      const r = await this.nextReply(timeout);
      if (r.kind === "result") return { result: { value: r.value, errno: r.errno }, data: Buffer.concat(chunks) };
      if (r.kind === "data") {
        chunks.push(Buffer.from(r.data));
        if (r.last) return { data: Buffer.concat(chunks) };
        timeout = this.timeouts.reply;
      } else if (r.kind === "busy") {
        timeout = this.timeouts.busy;
      }
      // Anything else (connect replies, requests from the unit) isn't for us; keep waiting.
    }
  }

  /** Open a session. Resolves with the unit's raw status reply. */
  connect(): Promise<Buffer> {
    return this.exclusive(async () => {
      this.queue.length = 0;
      this.transport.write(connectFrame());
      for (;;) {
        const r = await this.nextReply(this.timeouts.reply);
        if (r.kind === "connected") return r.payload;
      }
    });
  }

  list(path: string): Promise<DirEntry[]> {
    return this.exclusive(async () => {
      const opened = await this.call(openDirRequest(remotePath(path)));
      const dir = opened.result?.value ?? 0;
      if (!dir) throw new DeviceError(`Couldn't open folder ${path} on the SP-404MKII.`, opened.result?.errno);
      const entries: DirEntry[] = [];
      try {
        for (;;) {
          const r = await this.call(readDirRequest(dir));
          if (r.result) break; // end of listing
          const e = parseDirEntry(r.data);
          if (e.name !== "." && e.name !== "..") entries.push(e);
        }
      } finally {
        await this.call(closeDirRequest(dir));
      }
      return entries;
    });
  }

  private async openFile(path: string): Promise<number> {
    const r = await this.call(openRequest(remotePath(path)));
    const fd = r.result?.value ?? -1;
    if (fd < 0) throw new DeviceError(`Couldn't open ${path} on the SP-404MKII.`, r.result?.errno);
    return fd;
  }

  private async fstat(fd: number, path: string): Promise<Stat> {
    const r = await this.call(fstatRequest(fd));
    if (r.result || r.data.length < 8) throw new DeviceError(`Couldn't read the size of ${path}.`, r.result?.errno);
    return parseStat(r.data);
  }

  stat(path: string): Promise<Stat> {
    return this.exclusive(async () => {
      const fd = await this.openFile(path);
      try {
        return await this.fstat(fd, path);
      } finally {
        await this.call(closeRequest(fd));
      }
    });
  }

  /** Read a whole file. `limit` stops early (e.g. to read just a header). */
  readFile(path: string, onProgress?: (bytes: number, total: number) => void, limit = Infinity): Promise<Buffer> {
    return this.exclusive(async () => {
      const fd = await this.openFile(path);
      try {
        const { size } = await this.fstat(fd, path);
        const total = Math.min(size, limit);
        const out = Buffer.alloc(total);
        let got = 0;
        while (got < total) {
          const r = await this.call(readRequest(fd, Math.min(MAX_READ, total - got)));
          if (r.result && r.result.value < 0) throw new DeviceError(`Reading ${path} failed.`, r.result.errno);
          if (!r.data.length) break; // end of file
          r.data.copy(out, got, 0, Math.min(r.data.length, total - got));
          got += Math.min(r.data.length, total - got);
          onProgress?.(got, total);
        }
        if (got < total) throw new DeviceError(`${path} ended early (${got} of ${total} bytes).`);
        return out;
      } finally {
        await this.call(closeRequest(fd));
      }
    });
  }
}

export interface FoundPort {
  path: string;
}

/** Find the unit's serial port. Uses the call-out device (/dev/cu.*), which doesn't wait for carrier. */
export async function findSerialPort(): Promise<FoundPort | undefined> {
  const { SerialPort } = await import("serialport");
  const ports = await SerialPort.list();
  const p = ports.find(
    (x) => parseInt(x.vendorId ?? "", 16) === ROLAND_VENDOR_ID && parseInt(x.productId ?? "", 16) === SERIAL_PRODUCT_ID,
  );
  return p && { path: p.path.replace("/dev/tty.", "/dev/cu.") };
}

/** Open the serial link to a connected SP-404MKII. */
export async function openSerialTransport(path: string): Promise<Transport> {
  const { SerialPort } = await import("serialport");
  const port = new SerialPort({ path, baudRate: 230400, autoOpen: false });
  await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  return {
    write: (data) => void port.write(data),
    onData: (listener) => void port.on("data", listener),
    close: () => new Promise<void>((resolve) => (port.isOpen ? port.close(() => resolve()) : resolve())),
  };
}
