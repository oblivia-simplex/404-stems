// Keeps one connection to the unit for the server: opened when needed, closed when idle so
// Roland's own app can use the port, and running at most one project copy at a time.
import { Sp404Device, findSerialPort, openSerialTransport } from "./device.js";
import { DeviceProject, DownloadProgress, listProjects, downloadProject } from "./projects.js";

export type DeviceOpener = () => Promise<Sp404Device | undefined>;

export const openConnectedDevice: DeviceOpener = async () => {
  const port = await findSerialPort();
  return port && new Sp404Device(await openSerialTransport(port.path));
};

export interface CopyJob {
  id: number;
  slot: number;
  state: "running" | "done" | "failed" | "cancelled";
  progress?: DownloadProgress;
  dest?: string;
  error?: string;
}

const IDLE_CLOSE_MS = 15000;

export class DeviceLink {
  private dev: Sp404Device | undefined;
  private idle: NodeJS.Timeout | undefined;
  private job: CopyJob | undefined;
  private cancel = false;
  private nextJob = 1;

  constructor(private open: DeviceOpener = openConnectedDevice, private idleMs = IDLE_CLOSE_MS) {}

  private async device(): Promise<Sp404Device | undefined> {
    clearTimeout(this.idle);
    if (!this.dev) {
      this.dev = await this.open();
      if (!this.dev) return undefined;
      try {
        await this.dev.connect();
      } catch (err) {
        await this.drop();
        throw err;
      }
    }
    return this.dev;
  }

  private release() {
    clearTimeout(this.idle);
    if (this.job?.state === "running") return;
    this.idle = setTimeout(() => void this.drop(), this.idleMs);
  }

  private async drop() {
    clearTimeout(this.idle);
    const d = this.dev;
    this.dev = undefined;
    await d?.close().catch(() => undefined);
  }

  /** Projects on the unit, or undefined when no unit is connected. */
  async projects(): Promise<DeviceProject[] | undefined> {
    if (this.job?.state === "running") throw new Error("A project is being copied. Try again when it's done.");
    try {
      const dev = await this.device();
      const list = dev && (await listProjects(dev));
      this.release();
      return list;
    } catch (err) {
      await this.drop(); // a stale connection (unit unplugged, say) gets reopened next time
      throw err;
    }
  }

  /** Start copying a project; progress is read back with `status`. */
  start(slot: number, destRoot: string): CopyJob {
    if (this.job?.state === "running") throw new Error("Another project is already being copied.");
    const job: CopyJob = { id: this.nextJob++, slot, state: "running" };
    this.job = job;
    this.cancel = false;
    void (async () => {
      try {
        const dev = await this.device();
        if (!dev) throw new Error("No SP-404MKII found. Connect it with a USB cable and turn it on.");
        job.dest = await downloadProject(dev, slot, destRoot, (p) => (job.progress = p), () => this.cancel);
        job.state = "done";
      } catch (err) {
        job.state = this.cancel ? "cancelled" : "failed";
        job.error = (err as Error).message;
        await this.drop();
      } finally {
        this.release();
      }
    })();
    return job;
  }

  status(id: number): CopyJob | undefined {
    return this.job?.id === id ? this.job : undefined;
  }

  stop(id: number) {
    if (this.job?.id === id && this.job.state === "running") this.cancel = true;
  }

  async close() {
    this.cancel = true;
    await this.drop();
  }
}
