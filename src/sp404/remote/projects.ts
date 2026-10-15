// Listing and copying the projects stored inside an SP-404MKII.
import * as fs from "fs";
import * as path from "path";
import { Sp404Device, DeviceTimeoutError } from "./device.js";
import { PROJECT_SLOTS, projectDir } from "./protocol.js";

const NAME_AT = 0x80;
const NAME_END = 0xa0;

export interface DeviceProject {
  slot: number; // 1..16
  name: string; // as set on the unit; empty for an unnamed project
  folder: string; // suggested local folder name, e.g. "P3_HITCHHIKERS"
}

export function projectNameFromHeader(header: Buffer): string {
  return header.toString("latin1", NAME_AT, NAME_END).replace(/\0.*$/s, "").trim();
}

/** Folder name for a downloaded project, in the style the unit uses when exporting to SD. */
export function localFolderName(slot: number, name: string): string {
  const safe = name.replace(/[\/\\:*?"<>|]/g, "_").trim();
  return `P${slot}_${safe || `PROJECT_${String(slot).padStart(2, "0")}`}`;
}

export async function listProjects(dev: Sp404Device): Promise<DeviceProject[]> {
  const out: DeviceProject[] = [];
  for (let slot = 1; slot <= PROJECT_SLOTS; slot++) {
    let name = "";
    try {
      name = projectNameFromHeader(await dev.readFile(`${projectDir(slot)}/PADCONF.BIN`, undefined, NAME_END));
    } catch (err) {
      if (err instanceof DeviceTimeoutError) throw err;
      continue; // no PADCONF.BIN: an empty slot
    }
    out.push({ slot, name, folder: localFolderName(slot, name) });
  }
  return out;
}

export interface FileToCopy {
  rel: string; // path relative to the project folder, with "/" separators
  size: number;
}

/** Every file in a project folder on the unit, with sizes. */
export async function listProjectFiles(dev: Sp404Device, slot: number): Promise<FileToCopy[]> {
  const root = projectDir(slot);
  const files: FileToCopy[] = [];
  const walk = async (rel: string) => {
    for (const e of await dev.list(rel ? `${root}/${rel}` : root)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDir) await walk(r);
      else files.push({ rel: r, size: (await dev.stat(`${root}/${r}`)).size });
    }
  };
  await walk("");
  return files;
}

export interface DownloadProgress {
  file: string;
  filesDone: number;
  files: number;
  bytes: number;
  totalBytes: number;
}

/**
 * Copy a project from the unit into `destRoot/<folder>`. The copy is made in a temporary folder
 * first; an older copy at the same place is only replaced once the new one is complete.
 */
export async function downloadProject(
  dev: Sp404Device,
  slot: number,
  destRoot: string,
  onProgress?: (p: DownloadProgress) => void,
  shouldStop?: () => boolean,
): Promise<string> {
  const header = await dev.readFile(`${projectDir(slot)}/PADCONF.BIN`, undefined, NAME_END);
  const dest = path.join(destRoot, localFolderName(slot, projectNameFromHeader(header)));
  const files = await listProjectFiles(dev, slot);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const tmp = `${dest}.partial-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    let bytes = 0;
    for (const [i, f] of files.entries()) {
      if (shouldStop?.()) throw new Error("Download cancelled.");
      const base = bytes;
      const data = await dev.readFile(`${projectDir(slot)}/${f.rel}`, (got) =>
        onProgress?.({ file: f.rel, filesDone: i, files: files.length, bytes: base + got, totalBytes }),
      );
      const out = path.join(tmp, ...f.rel.split("/"));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      bytes += data.length;
      onProgress?.({ file: f.rel, filesDone: i + 1, files: files.length, bytes, totalBytes });
    }
    // Empty folders (an empty PTN, say) still belong in the project.
    for (const sub of ["SMPL", "PTN"]) fs.mkdirSync(path.join(tmp, sub), { recursive: true });
    if (fs.existsSync(dest)) {
      const old = `${dest}.old-${process.pid}`;
      fs.renameSync(dest, old);
      fs.renameSync(tmp, dest);
      fs.rmSync(old, { recursive: true, force: true });
    } else {
      fs.mkdirSync(destRoot, { recursive: true });
      fs.renameSync(tmp, dest);
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return dest;
}
