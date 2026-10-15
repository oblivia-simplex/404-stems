#!/usr/bin/env node
// Local web UI for exporting SP-404MKII pattern stems.
// Usage: sp404-stems [folder with projects, e.g. an SD card or export folder] [--port N] [--no-open]
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { findProjects, loadProject, Project } from "./sp404/project.js";
import { renderStems, renderPad, RenderOptions, StereoBuffer, StemRender, OUTPUT_RATE, TailMode } from "./sp404/render.js";
import { encodeWav16, encodeWavFloat } from "./sp404/wav.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 4040;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
const DEFAULT_ROOT = path.resolve(positional[0] ?? process.cwd());
const DEFAULT_OUT = path.join(os.homedir(), "Music", "SP404 Stems");

const projects = new Map<string, Project>();
function getProject(dir: string): Project {
  let p = projects.get(dir);
  if (!p) projects.set(dir, (p = loadProject(dir)));
  return p;
}

interface RenderRequest {
  dir: string;
  sequence: number[];
  groups: Record<string, number[]>;
  bpm?: number; // omit to use each pattern's bank tempo
  tail: TailMode;
}

// Previewing several stems of the same render shouldn't re-render each time.
let lastRender: { key: string; result: StemRender } | undefined;
function render(req: RenderRequest): StemRender {
  const key = JSON.stringify([req.dir, req.sequence, req.groups, req.bpm, req.tail]);
  if (lastRender?.key === key) return lastRender.result;
  const opts: RenderOptions = { bpm: req.bpm, tail: req.tail };
  const result = renderStems(getProject(req.dir), req.sequence, req.groups, opts);
  lastRender = { key, result };
  return result;
}

// Preview audio is 16-bit; scale down rather than clip if the sum is hot.
function previewWav(buf: StereoBuffer): Buffer {
  let peak = 0;
  for (let i = 0; i < buf.left.length; i++) peak = Math.max(peak, Math.abs(buf.left[i]), Math.abs(buf.right[i]));
  if (peak <= 1) return encodeWav16(buf.left, buf.right, OUTPUT_RATE);
  const k = 0.98 / peak;
  return encodeWav16(buf.left.map((v) => v * k), buf.right.map((v) => v * k), OUTPUT_RATE);
}

function safeName(s: string): string {
  return s.replace(/[\/\\:*?"<>|]/g, "_").trim() || "untitled";
}

function projectSummary(p: Project) {
  return {
    dir: p.dir,
    name: p.conf.projectName || path.basename(p.dir),
    bankBpm: p.conf.bankBpm,
    pads: p.conf.pads.map(({ raw, ...pad }) => ({ ...pad, hasSample: p.hasSample[pad.index] })),
    patterns: [...p.patterns.values()].map((ptn) => ({
      number: ptn.number,
      label: ptn.label,
      bars: ptn.bars,
      bpm: p.conf.bankBpm[Math.floor((ptn.number - 1) / 16)],
      events: ptn.events.length,
      pads: [...new Set(ptn.events.map((e) => e.pad))].sort((a, b) => a - b),
    })),
    chains: p.chains,
  };
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function send(res: http.ServerResponse, status: number, body: Buffer | string, type: string) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const json = (res: http.ServerResponse, v: unknown, status = 200) => send(res, status, JSON.stringify(v), "application/json");

const STATIC_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const q = url.searchParams;
  try {
    switch (url.pathname) {
      case "/api/config":
        return json(res, { root: DEFAULT_ROOT, outDir: DEFAULT_OUT });
      case "/api/projects": {
        const root = path.resolve(q.get("root") || DEFAULT_ROOT);
        return json(res, { root, projects: findProjects(root).map((dir) => ({ dir, name: path.basename(dir) })) });
      }
      case "/api/project": {
        const dir = q.get("dir")!;
        if (q.get("reload")) projects.delete(dir);
        return json(res, projectSummary(getProject(dir)));
      }
      case "/api/pad.wav": {
        const buf = renderPad(getProject(q.get("dir")!), Number(q.get("pad")));
        return send(res, 200, previewWav(buf), "audio/wav");
      }
      case "/api/render.wav": {
        const r = JSON.parse(q.get("req")!) as RenderRequest;
        const result = render(r);
        const stem = q.get("stem");
        const buf = stem ? result.stems.get(stem) : result.mix;
        if (!buf) return send(res, 404, "no such stem", "text/plain");
        return send(res, 200, previewWav(buf), "audio/wav");
      }
      case "/api/render": {
        // Render and report which stems exist, so the UI can offer per-stem preview.
        const r = await readJson<RenderRequest>(req);
        const result = render(r);
        return json(res, { seconds: result.frames / OUTPUT_RATE, stems: [...result.stems.keys()], usedPads: result.usedPads });
      }
      case "/api/export": {
        const r = await readJson<RenderRequest & { outDir: string; label: string; includeMix: boolean }>(req);
        const project = getProject(r.dir);
        const result = render(r);
        const dest = path.join(path.resolve(r.outDir || DEFAULT_OUT), safeName(project.conf.projectName || path.basename(r.dir)), safeName(r.label));
        fs.mkdirSync(dest, { recursive: true });
        const written: string[] = [];
        for (const [name, buf] of result.stems) {
          const f = path.join(dest, `${safeName(name)}.wav`);
          fs.writeFileSync(f, encodeWavFloat(buf.left, buf.right, OUTPUT_RATE));
          written.push(f);
        }
        if (r.includeMix) {
          const f = path.join(dest, "_mix.wav");
          fs.writeFileSync(f, encodeWavFloat(result.mix.left, result.mix.right, OUTPUT_RATE));
          written.push(f);
        }
        return json(res, { dest, written });
      }
      case "/api/reveal": {
        exec(`open ${JSON.stringify(q.get("path")!)}`);
        return json(res, { ok: true });
      }
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(WEB_DIR, path.normalize(rel));
    if (!file.startsWith(WEB_DIR) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), STATIC_TYPES[path.extname(file)] ?? "application/octet-stream");
  } catch (err) {
    console.error(err);
    return json(res, { error: (err as Error).message }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const link = `http://127.0.0.1:${PORT}/`;
  console.log(`🎛  SP-404MKII stem exporter running at ${link}`);
  console.log(`   Looking for projects under ${DEFAULT_ROOT}`);
  if (!args.includes("--no-open")) exec(`open ${link}`);
});
