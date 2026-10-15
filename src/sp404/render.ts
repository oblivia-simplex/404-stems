import { Project, getSample } from "./project.js";
import { PadParams } from "./padconf.js";
import { byteOffsetToFrame } from "./smp.js";
import { PPQN } from "./pattern.js";

export const OUTPUT_RATE = 48000;
const STOP_FADE_FRAMES = 240; // 5 ms fade when a voice is gated or choked, to avoid clicks

export type TailMode = "cut" | "extend" | "wrap";

export interface RenderOptions {
  bpm?: number; // overrides each pattern's bank tempo when set
  tail: TailMode;
}

export interface StereoBuffer {
  left: Float32Array;
  right: Float32Array;
}

export interface StemRender {
  frames: number;
  stems: Map<string, StereoBuffer>;
  mix: StereoBuffer;
  usedPads: number[];
}

interface Voice {
  pad: number;
  start: number; // output frame
  stop: number; // output frame at which the voice is cut (Infinity = play out)
  gain: number;
  note: number;
}

function stereo(frames: number): StereoBuffer {
  return { left: new Float32Array(frames), right: new Float32Array(frames) };
}

function panGains(pan: number): [number, number] {
  // Equal-power, unity at centre.
  const t = (Math.min(127, Math.max(0, pan)) / 127) * (Math.PI / 2);
  return [Math.cos(t) * Math.SQRT2, Math.sin(t) * Math.SQRT2];
}

// Mix one voice into `out` starting at `voice.start`; returns the frame after its last sample.
function renderVoice(project: Project, p: PadParams, voice: Voice, out: StereoBuffer, limit: number): number {
  const s = getSample(project.dir, p.index);
  const total = s.left.length;
  const startF = Math.min(byteOffsetToFrame(p.start, s.channels), total);
  const endF = Math.min(Math.max(byteOffsetToFrame(p.end, s.channels), startF), total);
  const loopF = Math.min(Math.max(byteOffsetToFrame(p.loopStart, s.channels), startF), endF);
  const span = endF - startF;
  if (span <= 1) return voice.start;
  const ratio = (s.rate / OUTPUT_RATE) * Math.pow(2, (p.pitch + voice.note + p.fine / 100) / 12);
  const [gl, gr] = panGains(p.pan);
  const gainL = voice.gain * gl;
  const gainR = voice.gain * gr;
  const hardStop = Math.min(limit, voice.stop + STOP_FADE_FRAMES);
  let o = voice.start;
  for (let k = 0; o < hardStop; k++, o++) {
    let pos = k * ratio; // offset from start point, in source frames
    if (pos >= span - 1) {
      if (!p.loop || endF - loopF < 2) break;
      const loopLen = endF - loopF;
      pos = loopF - startF + ((pos - (loopF - startF)) % loopLen);
    }
    if (p.reverse) pos = span - 1 - pos;
    const i = startF + Math.floor(pos);
    const f = pos - Math.floor(pos);
    const j = Math.min(i + 1, endF - 1);
    let env = 1;
    if (o >= voice.stop) env = 1 - (o - voice.stop) / STOP_FADE_FRAMES;
    out.left[o] += (s.left[i] + (s.left[j] - s.left[i]) * f) * gainL * env;
    out.right[o] += (s.right[i] + (s.right[j] - s.right[i]) * f) * gainR * env;
  }
  return o;
}

export function patternBpm(project: Project, pattern: number, opts: RenderOptions): number {
  return opts.bpm || project.conf.bankBpm[Math.floor((pattern - 1) / 16)];
}

// Render a sequence of patterns (a single pattern, or a chain) into one stem per group.
// `groups` maps stem name -> pad indices; used pads in no group go to an "ungrouped" stem.
export function renderStems(
  project: Project,
  sequence: number[],
  groups: Record<string, number[]>,
  opts: RenderOptions,
): StemRender {
  const pads = project.conf.pads;
  const voices: Voice[] = [];
  let offset = 0; // output frames
  for (const n of sequence) {
    const ptn = project.patterns.get(n);
    if (!ptn) continue;
    const framesPerTick = (OUTPUT_RATE * 60) / (patternBpm(project, n, opts) * PPQN);
    for (const e of ptn.events) {
      if (!project.hasSample[e.pad]) continue;
      const p = pads[e.pad];
      const start = offset + Math.round(e.tick * framesPerTick);
      voices.push({
        pad: e.pad,
        start,
        stop: p.gate ? start + Math.max(1, Math.round(e.length * framesPerTick)) : Infinity,
        gain: (p.volume / 127) * (e.velocity / 127),
        note: e.note,
      });
    }
    offset += Math.round(ptn.ticks * framesPerTick);
  }
  const seqFrames = offset;

  // A new hit cuts the previous voice on the same pad, and on any pad in the same mute group.
  voices.sort((a, b) => a.start - b.start);
  const lastByPad = new Map<number, Voice>();
  const lastByGroup = new Map<number, Voice>();
  for (const v of voices) {
    const prev = [lastByPad.get(v.pad)];
    const mg = pads[v.pad].muteGroup;
    if (mg) prev.push(lastByGroup.get(mg));
    for (const pv of prev) if (pv && pv.stop > v.start) pv.stop = v.start;
    lastByPad.set(v.pad, v);
    if (mg) lastByGroup.set(mg, v);
  }
  // Ungated loops would otherwise run forever; stop them at the end of the sequence.
  for (const v of voices) if (pads[v.pad].loop && v.stop === Infinity) v.stop = seqFrames;

  const stemOf = new Map<number, string>();
  for (const [name, members] of Object.entries(groups)) for (const pad of members) stemOf.set(pad, name);

  // Render with room for tails, then trim or fold according to the tail mode.
  const maxTail = OUTPUT_RATE * 60;
  const work = new Map<string, StereoBuffer>();
  let end = seqFrames;
  for (const v of voices) {
    const name = stemOf.get(v.pad) ?? "ungrouped";
    let buf = work.get(name);
    if (!buf) work.set(name, (buf = stereo(seqFrames + maxTail)));
    end = Math.max(end, renderVoice(project, pads[v.pad], v, buf, seqFrames + maxTail));
  }

  const frames = opts.tail === "extend" ? end : seqFrames;
  const stems = new Map<string, StereoBuffer>();
  const mix = stereo(frames);
  for (const [name, buf] of work) {
    const out = stereo(frames);
    for (let i = 0; i < end; i++) {
      if (i >= frames && opts.tail !== "wrap") break;
      const o = i % frames;
      out.left[o] += buf.left[i];
      out.right[o] += buf.right[i];
    }
    for (let i = 0; i < frames; i++) {
      mix.left[i] += out.left[i];
      mix.right[i] += out.right[i];
    }
    stems.set(name, out);
  }
  const usedPads = [...new Set(voices.map((v) => v.pad))].sort((a, b) => a - b);
  return { frames, stems, mix, usedPads };
}

// A single pad as the device would play it on one hit (start/end, reverse, pitch, volume, pan; no looping).
export function renderPad(project: Project, pad: number): StereoBuffer {
  const p = { ...project.conf.pads[pad], loop: false };
  const s = getSample(project.dir, pad);
  const out = stereo(Math.ceil((s.left.length * OUTPUT_RATE) / s.rate / Math.pow(2, (p.pitch + p.fine / 100) / 12)) + 1);
  const n = renderVoice(project, p, { pad, start: 0, stop: Infinity, gain: p.volume / 127, note: 0 }, out, out.left.length);
  return { left: out.left.subarray(0, n), right: out.right.subarray(0, n) };
}
