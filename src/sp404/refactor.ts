import * as fs from "fs";
import * as path from "path";
import { Project, sampleFile } from "./project.js";
import { bankVolumeOffset, padLabel, PAD_COUNT } from "./padconf.js";

// "Refactor" a chain (or single pattern) into a new project: keep only the pads its patterns play,
// give each stem its own bank, and rewrite the patterns to point at the new pad positions.
// The source project is never modified.

const HEADER_SIZE = 0xa0;
const RECORD_SIZE = 0xac;
const NAME_SIZE = 24;
const NAMES_AT = HEADER_SIZE + PAD_COUNT * RECORD_SIZE;
const EXTRA_SIZE = 0x80; // per-pad block after the names (marks, etc.)
const EXTRA_AT = NAMES_AT + PAD_COUNT * NAME_SIZE;
const PAD_NONE = 0x80;
const END_OF_DATA = 0x8c;
const PAD_BASE = 0x2f;
const UNGROUPED = "Pads in no stem";

// What every empty pad slot looks like in projects saved by the device.
const EMPTY_RECORD = (() => {
  const w = new Array(RECORD_SIZE / 4).fill(0);
  Object.assign(w, { 3: 0x7f, 4: 1, 6: 1, 9: 9000, 16: 10000, 17: 1, 18: 0x40, 20: 1, 21: 2, 23: 100 });
  const b = Buffer.alloc(RECORD_SIZE);
  w.forEach((v, k) => b.writeInt32BE(v, k * 4));
  return b;
})();
const EMPTY_NAME = Buffer.concat([Buffer.alloc(NAME_SIZE - 1, 0x20), Buffer.alloc(1)]);
const EMPTY_EXTRA = Buffer.concat([Buffer.alloc(EXTRA_SIZE / 2, 0xff), Buffer.alloc(EXTRA_SIZE / 2)]);

export interface StemPlacement {
  stem: string;
  moves: { from: number; to: number; fromLabel: string; toLabel: string }[];
}

export interface RefactorPlan {
  stems: StemPlacement[];
  patterns: number[];
  warnings: string[];
  errors: string[];
}

export function planRefactor(project: Project, sequence: number[], groups: Record<string, number[]>): RefactorPlan {
  const warnings: string[] = [];
  const errors: string[] = [];
  const patterns = [...new Set(sequence)].filter((n) => project.patterns.has(n));
  const used = new Set<number>();
  for (const n of patterns) for (const e of project.patterns.get(n)!.events) if (project.hasSample[e.pad]) used.add(e.pad);

  const stems: { name: string; pads: number[] }[] = [];
  const claimed = new Set<number>();
  for (const [name, members] of Object.entries(groups)) {
    const pads = members.filter((p) => used.has(p) && !claimed.has(p)).sort((a, b) => a - b);
    pads.forEach((p) => claimed.add(p));
    if (pads.length) stems.push({ name, pads });
  }
  const loose = [...used].filter((p) => !claimed.has(p)).sort((a, b) => a - b);
  if (loose.length) {
    stems.push({ name: UNGROUPED, pads: loose });
    warnings.push(`${loose.length} pads played by these patterns aren't in any stem (${loose.map(padLabel).join(", ")}). They'll share a bank at the end.`);
  }

  const placed: StemPlacement[] = [];
  let bank = 0;
  for (const s of stems) {
    const banks = Math.ceil(s.pads.length / 16);
    if (banks > 1) {
      warnings.push(`"${s.name}" has ${s.pads.length} pads, more than one bank holds, so it will spill across ${banks} banks. Consider splitting it into smaller stems.`);
    }
    placed.push({
      stem: s.name,
      moves: s.pads.map((from, k) => {
        const to = bank * 16 + k;
        return { from, to, fromLabel: padLabel(from), toLabel: to < PAD_COUNT ? padLabel(to) : "—" };
      }),
    });
    bank += banks;
  }
  if (bank > 10) errors.push(`These stems need ${bank} banks, but a project only has 10. Merge some stems or move pads between them.`);
  if (!used.size) errors.push("These patterns don't play any pads with samples, so there's nothing to copy.");
  return { stems: placed, patterns, warnings, errors };
}

function sanitizeProjectName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_ -]/g, "_").slice(0, 31);
}

function copyDir(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

export interface RefactorResult {
  dest: string;
  samples: number;
  patterns: number;
}

export function executeRefactor(
  project: Project,
  sequence: number[],
  groups: Record<string, number[]>,
  dest: string,
  projectName: string,
  chainNumber?: number,
): RefactorResult {
  const plan = planRefactor(project, sequence, groups);
  if (plan.errors.length) throw new Error(plan.errors.join(" "));
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists. Choose a different name.`);
  const map = new Map<number, number>();
  for (const s of plan.stems) for (const m of s.moves) map.set(m.from, m.to);

  // Build everything in a temporary folder first, so a failure never leaves a half-written project.
  const tmp = `${dest}.partial-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(tmp, "SMPL"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "PTN"), { recursive: true });

    // PADCONF: header kept, every slot emptied, then kept pads written at their new positions.
    const src = fs.readFileSync(path.join(project.dir, "PADCONF.BIN"));
    const out = Buffer.from(src);
    for (let i = 0; i < PAD_COUNT; i++) {
      EMPTY_RECORD.copy(out, HEADER_SIZE + i * RECORD_SIZE);
      EMPTY_NAME.copy(out, NAMES_AT + i * NAME_SIZE);
      EMPTY_EXTRA.copy(out, EXTRA_AT + i * EXTRA_SIZE);
    }
    for (const [from, to] of map) {
      src.copy(out, HEADER_SIZE + to * RECORD_SIZE, HEADER_SIZE + from * RECORD_SIZE, HEADER_SIZE + (from + 1) * RECORD_SIZE);
      src.copy(out, NAMES_AT + to * NAME_SIZE, NAMES_AT + from * NAME_SIZE, NAMES_AT + (from + 1) * NAME_SIZE);
      src.copy(out, EXTRA_AT + to * EXTRA_SIZE, EXTRA_AT + from * EXTRA_SIZE, EXTRA_AT + (from + 1) * EXTRA_SIZE);
      fs.copyFileSync(sampleFile(project.dir, from), sampleFile(tmp, to));
      // Pads change banks, so fold the old bank's BANK VOLUME into the pad's own volume (word 3).
      const vol = Math.round((project.conf.pads[from].volume * (project.conf.bankVolume?.[Math.floor(from / 16)] ?? 127)) / 127);
      out.writeInt32BE(vol, HEADER_SIZE + to * RECORD_SIZE + 12);
    }
    // ...and leave every bank at its default level.
    for (let b = 0; b < 10; b++) out.writeUInt16BE(0, bankVolumeOffset(b));
    const name = sanitizeProjectName(projectName);
    Buffer.concat([Buffer.from(name.padEnd(31, " "), "latin1"), Buffer.alloc(1)]).copy(out, 0x80);
    fs.writeFileSync(path.join(tmp, "PADCONF.BIN"), out);

    // Patterns: rewrite pad references in place. Notes on pads that aren't kept (no sample) become
    // empty time-filler records with the same tick delta, so timing is unchanged.
    for (const n of plan.patterns) {
      const file = `PTN${String(n).padStart(5, "0")}.BIN`;
      const buf = Buffer.from(fs.readFileSync(path.join(project.dir, "PTN", file)));
      for (let o = 0; o + 8 <= buf.length - 8; o += 8) {
        if (buf[o + 1] === END_OF_DATA) break;
        if (buf[o + 1] === PAD_NONE) continue;
        const pad = buf[o + 1] - PAD_BASE + 80 * (buf[o + 2] & 1);
        const to = map.get(pad);
        if (to === undefined) {
          buf.fill(0, o + 1, o + 8);
          buf[o + 1] = PAD_NONE;
        } else {
          buf[o + 1] = PAD_BASE + (to % 80);
          buf[o + 2] = (buf[o + 2] & ~1) | (to >= 80 ? 1 : 0);
        }
      }
      fs.writeFileSync(path.join(tmp, "PTN", file), buf);
    }
    if (chainNumber !== undefined) {
      const chain = fs.readdirSync(path.join(project.dir, "PTN")).find((f) => new RegExp(`^PATTERNCHAIN_0*${chainNumber}\\.CHN$`, "i").test(f));
      if (chain) fs.copyFileSync(path.join(project.dir, "PTN", chain), path.join(tmp, "PTN", chain));
    }

    // Anything else in the project (pictures, etc.) is copied unchanged.
    for (const e of fs.readdirSync(project.dir, { withFileTypes: true })) {
      if (["PADCONF.BIN", "SMPL", "PTN"].includes(e.name.toUpperCase()) || e.name.startsWith(".")) continue;
      const a = path.join(project.dir, e.name);
      if (e.isDirectory()) copyDir(a, path.join(tmp, e.name));
      else if (e.isFile()) fs.copyFileSync(a, path.join(tmp, e.name));
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return { dest, samples: map.size, patterns: plan.patterns.length };
}
