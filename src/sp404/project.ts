import * as fs from "fs";
import * as path from "path";
import { readPadConf, PadConf } from "./padconf.js";
import { readPattern, readChain, Pattern, Chain } from "./pattern.js";
import { readSmp, Sample } from "./smp.js";

export interface Project {
  dir: string;
  conf: PadConf;
  patterns: Map<number, Pattern>;
  chains: Chain[];
  hasSample: boolean[];
}

export function sampleFile(dir: string, pad: number): string {
  return path.join(dir, "SMPL", `BANK${Math.floor(pad / 16) + 1}-${String((pad % 16) + 1).padStart(2, "0")}.SMP`);
}

export function loadProject(dir: string): Project {
  const conf = readPadConf(path.join(dir, "PADCONF.BIN"));
  const patterns = new Map<number, Pattern>();
  const chains: Chain[] = [];
  const ptnDir = path.join(dir, "PTN");
  if (fs.existsSync(ptnDir)) {
    for (const f of fs.readdirSync(ptnDir)) {
      let m = /^PTN(\d{5})\.BIN$/i.exec(f);
      if (m) {
        const n = Number(m[1]);
        patterns.set(n, readPattern(path.join(ptnDir, f), n));
        continue;
      }
      m = /^PATTERNCHAIN_(\d+)\.CHN$/i.exec(f);
      if (m) chains.push(readChain(path.join(ptnDir, f), Number(m[1])));
    }
  }
  chains.sort((a, b) => a.number - b.number);
  const hasSample = conf.pads.map((p) => fs.existsSync(sampleFile(dir, p.index)));
  return { dir, conf, patterns: new Map([...patterns].sort((a, b) => a[0] - b[0])), chains, hasSample };
}

// Find project folders (anything containing PADCONF.BIN) under a root such as an SD card or export folder.
export function findProjects(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name.toUpperCase() === "PADCONF.BIN")) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (["SMPL", "PTN", "PICTURE", "IMPORT"].includes(e.name.toUpperCase())) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Decoded samples are large; keep the most recently used ones only.
const sampleCache = new Map<string, Sample>();
const SAMPLE_CACHE_MAX = 200;

export function getSample(dir: string, pad: number): Sample {
  const file = sampleFile(dir, pad);
  let s = sampleCache.get(file);
  if (s) {
    sampleCache.delete(file);
  } else {
    s = readSmp(file);
    if (sampleCache.size >= SAMPLE_CACHE_MAX) sampleCache.delete(sampleCache.keys().next().value!);
  }
  sampleCache.set(file, s);
  return s;
}
