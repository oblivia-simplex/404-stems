import { Project, getSample } from "./project.js";
import { PadParams, bankTempo } from "./padconf.js";
import { byteOffsetToFrame } from "./smp.js";
import { PPQN } from "./pattern.js";
import { resample, timeStretch, VariMode } from "./stretch.js";

export const OUTPUT_RATE = 48000;
const STOP_FADE_FRAMES = 240; // 5 ms fade when a voice is gated or choked, to avoid clicks

export type TailMode = "cut" | "extend" | "wrap";
// What happens to sounds still playing when the sequence moves to a different pattern:
// "mk2" cuts them at the boundary (a pattern repeating itself carries on); "sx" lets them ring on.
export type ContinuationMode = "mk2" | "sx";

export interface RenderOptions {
  bpm?: number; // overrides the project/bank tempo when set
  tail: TailMode;
  continuation?: ContinuationMode;
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
  timeline: Timeline;
}

// Where things happen in a render, for the playback display. Times are in output frames.
export interface Timeline {
  segments: { pattern: number; label: string; start: number; end: number; bpm: number; bars: number; beatsPerBar: number; beatUnit: number }[];
  hits: { pad: number; start: number; end: number; cut?: CutReason }[];
}

export type CutReason = "gate" | "retrigger" | "mute group" | "loop toggle" | "pattern change" | "sequence end";

interface Voice {
  cut?: CutReason; // why the voice stopped before playing out, if it did
  gated?: boolean; // the stop releases the voice (gate or mute group), so its release envelope applies
  end?: number; // frame after the voice's last sample, once rendered
  pad: number;
  start: number; // output frame
  stop: number; // output frame at which the voice is cut (Infinity = play out)
  gain: number;
  note: number;
  bpm: number; // tempo the voice plays at, for BPM-synced pads
}

// What a voice reads from: frames [start, end) of left/right, stepped at `ratio` per output frame.
interface Source {
  left: Float32Array;
  right: Float32Array;
  start: number;
  end: number;
  loopStart: number;
  ratio: number;
  reverse: boolean;
}

// Pad word 10: bit 0 = VINYL mode (pitch and speed change together, like a record);
// bits 1-2 = VARI mode used when VINYL is off: 0 = Off, 1 = Backing (attacky sounds), 2 = Ensemble (sustained).
export function isVinyl(p: PadParams): boolean {
  return (p.raw[10] & 1) !== 0;
}
export function variMode(p: PadParams): number {
  return (p.raw[10] >> 1) & 3;
}

// Pitch-shifted and/or time-stretched audio, reused across hits with the same speed and note.
const stretchCache = new Map<string, Source>();
const STRETCH_CACHE_MAX = 64;

function voiceSource(project: Project, p: PadParams, voice: Voice): Source | null {
  const s = getSample(project.dir, p.index);
  const total = s.left.length;
  const start = Math.min(byteOffsetToFrame(p.start, s.channels), total);
  const end = Math.min(Math.max(byteOffsetToFrame(p.end, s.channels), start), total);
  const loopStart = Math.min(Math.max(byteOffsetToFrame(p.loopStart, s.channels), start), end);
  if (end - start <= 1) return null;
  const pitchRatio = Math.pow(2, (p.pitch + voice.note + p.fine / 100) / 12);
  // Playback speed: BPM-synced pads follow the current tempo; others use their speed setting.
  const speed = p.bpmSync && p.bpm > 0 ? voice.bpm / p.bpm : p.speed > 0 ? p.speed : 1;
  const rateRatio = s.rate / OUTPUT_RATE;

  if (isVinyl(p) || (Math.abs(pitchRatio - 1) < 1e-6 && Math.abs(speed - 1) < 1e-4)) {
    // Vinyl (or nothing to do): plain resampling, so pitch and speed move together.
    return { left: s.left, right: s.right, start, end, loopStart, ratio: rateRatio * pitchRatio * speed, reverse: p.reverse };
  }
  // Independent pitch and time: shift pitch keeping the length, then stretch the length by 1/speed.
  const key = `${project.dir}|${p.index}|${speed.toFixed(6)}|${voice.note}`;
  let src = stretchCache.get(key);
  if (!src) {
    const region = { left: s.left.slice(start, end), right: s.right.slice(start, end) };
    if (p.reverse) {
      region.left.reverse();
      region.right.reverse();
    }
    const pitched = resample(region, rateRatio * pitchRatio);
    const { left, right } = timeStretch(pitched, pitchRatio / speed, variMode(p) as VariMode);
    src = {
      left, right, start: 0, end: left.length,
      loopStart: p.reverse ? 0 : Math.min(left.length, Math.round((loopStart - start) / speed)),
      ratio: 1, reverse: false,
    };
    if (stretchCache.size >= STRETCH_CACHE_MAX) stretchCache.delete(stretchCache.keys().next().value!);
    stretchCache.set(key, src);
  }
  return src;
}

function stereo(frames: number): StereoBuffer {
  return { left: new Float32Array(frames), right: new Float32Array(frames) };
}

function panGains(pan: number): [number, number] {
  // Equal-power, unity at centre.
  const t = (Math.min(127, Math.max(0, pan)) / 127) * (Math.PI / 2);
  return [Math.cos(t) * Math.SQRT2, Math.sin(t) * Math.SQRT2];
}

// Envelope times: 0..127 maps to 0..3 seconds (the manual gives 127 = 3 s; linear is an assumption).
const envFrames = (v: number) => Math.round((Math.max(0, v) / 127) * 3 * OUTPUT_RATE);

// Mix one voice into `out` starting at `voice.start`; returns the frame after its last sample.
function renderVoice(project: Project, p: PadParams, voice: Voice, out: StereoBuffer, limit: number): number {
  const s = voiceSource(project, p, voice);
  if (!s) return voice.start;
  const { start: startF, end: endF, loopStart: loopF, ratio } = s;
  const span = endF - startF;
  // HOLD plays only the first hold% of the start..end range (one-shots; loops keep the full range).
  const played = p.loop ? span : Math.max(2, Math.floor((span * Math.min(100, p.hold)) / 100));
  const natural = p.loop ? Infinity : Math.floor((played - 1) / ratio); // output frames until the end
  const attack = envFrames(p.attack);
  const release = envFrames(p.release);
  // Gated notes and mute-group cuts fade out over the release time; same-pitch retriggers cut quickly.
  const stopFade = voice.gated ? Math.max(STOP_FADE_FRAMES, release) : STOP_FADE_FRAMES;
  const [gl, gr] = panGains(p.pan);
  const gainL = voice.gain * gl;
  const gainR = voice.gain * gr;
  const hardStop = Math.min(limit, voice.stop + stopFade, voice.start + natural);
  let o = voice.start;
  for (let k = 0; o < hardStop; k++, o++) {
    let pos = k * ratio; // offset from start point, in source frames
    if (pos >= played - 1) {
      if (!p.loop || endF - loopF < 2) break;
      const loopLen = endF - loopF;
      pos = loopF - startF + ((pos - (loopF - startF)) % loopLen);
    }
    if (s.reverse) pos = span - 1 - pos;
    const i = startF + Math.floor(pos);
    const f = pos - Math.floor(pos);
    const j = Math.min(i + 1, endF - 1);
    let env = 1;
    if (attack && k < attack) env *= k / attack;
    // Fade-out over the release time, ending where the played range ends.
    if (release && natural !== Infinity && natural - k < release) env *= Math.max(0, natural - k) / release;
    if (o >= voice.stop) env *= Math.max(0, 1 - (o - voice.stop) / stopFade);
    out.left[o] += (s.left[i] + (s.left[j] - s.left[i]) * f) * gainL * env;
    out.right[o] += (s.right[i] + (s.right[j] - s.right[i]) * f) * gainR * env;
  }
  return o;
}

export function patternBpm(project: Project, pattern: number, opts: RenderOptions): number {
  return opts.bpm || bankTempo(project.conf, Math.floor((pattern - 1) / 16));
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
  const segments: Timeline["segments"] = [];
  const changes: number[] = []; // frames where the sequence moves to a different pattern
  let previous: number | undefined;
  for (const n of sequence) {
    const ptn = project.patterns.get(n);
    if (!ptn) continue;
    if (previous !== undefined && previous !== n) changes.push(offset);
    previous = n;
    const framesPerTick = (OUTPUT_RATE * 60) / (patternBpm(project, n, opts) * PPQN);
    for (const e of ptn.events) {
      if (!project.hasSample[e.pad]) continue;
      const p = pads[e.pad];
      const start = offset + Math.round(e.tick * framesPerTick);
      voices.push({
        pad: e.pad,
        start,
        stop: p.gate ? start + Math.max(1, Math.round(e.length * framesPerTick)) : Infinity,
        gated: p.gate,
        cut: p.gate ? "gate" : undefined,
        gain: (p.volume / 127) * (e.velocity / 127),
        note: e.note,
        bpm: patternBpm(project, n, opts),
      });
    }
    const length = Math.round(ptn.ticks * framesPerTick);
    segments.push({ pattern: n, label: ptn.label, start: offset, end: offset + length, bpm: patternBpm(project, n, opts), bars: ptn.bars, beatsPerBar: ptn.beatsPerBar, beatUnit: ptn.beatUnit });
    offset += length;
  }
  const seqFrames = offset;
  // Looping back from the last pattern to the first is also a change, if they differ.
  const played = sequence.filter((n) => project.patterns.has(n));
  if (opts.tail === "wrap" && played.length && played[0] !== played[played.length - 1]) changes.push(seqFrames);

  // A new hit on a pad cuts its previous voice at the same pitch (a different chromatic note keeps
  // playing); a hit on another pad in the same mute group releases the voice it replaces.
  // A looping pad without gate toggles instead: a hit while its loop is playing just stops it.
  voices.sort((a, b) => a.start - b.start);
  const lastByPad = new Map<number, Voice>();
  const lastByPitch = new Map<string, Voice>();
  const sounding = new Map<number, Voice[]>(); // per mute group
  const kept: Voice[] = [];
  for (const v of voices) {
    const p = pads[v.pad];
    const mine = lastByPad.get(v.pad);
    if (p.loop && !p.gate && mine && mine.stop > v.start) {
      mine.stop = v.start;
      mine.gated = false;
      mine.cut = "loop toggle";
      lastByPad.delete(v.pad);
      continue;
    }
    const pitchKey = `${v.pad}:${v.note}`;
    const same = lastByPitch.get(pitchKey);
    if (same && same.stop > v.start) {
      same.stop = v.start;
      same.gated = false;
      same.cut = "retrigger";
    }
    const mg = p.muteGroup;
    if (mg) {
      const group = (sounding.get(mg) ?? []).filter((r) => r.stop > v.start);
      for (const rival of group) {
        if (rival.pad === v.pad) continue;
        rival.stop = v.start;
        rival.gated = true;
        rival.cut = "mute group";
      }
      sounding.set(mg, [...group.filter((r) => r.pad === v.pad), v]);
    }
    lastByPad.set(v.pad, v);
    lastByPitch.set(pitchKey, v);
    kept.push(v);
  }
  voices.length = 0;
  voices.push(...kept);
  if ((opts.continuation ?? "mk2") === "mk2") {
    for (const v of voices) {
      const cut = changes.find((c) => c > v.start);
      if (cut !== undefined && v.stop > cut) {
        v.stop = cut;
        v.gated = false;
        v.cut = "pattern change";
      }
    }
  }
  // Ungated loops would otherwise run forever; stop them at the end of the sequence.
  for (const v of voices) {
    if (pads[v.pad].loop && v.stop === Infinity) {
      v.stop = seqFrames;
      v.cut = "sequence end";
    }
  }

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
    v.end = renderVoice(project, pads[v.pad], v, buf, seqFrames + maxTail);
    end = Math.max(end, v.end);
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
  // In "wrap" mode, sound past the end is heard at the start; the display shows hits up to the end.
  const hits = voices.filter((v) => v.end !== undefined && v.end > v.start && v.start < frames).map((v) => ({
    pad: v.pad, start: v.start, end: Math.min(v.end!, frames),
    // Only report a cut if it actually shortened the sound.
    cut: v.cut && v.stop !== Infinity && v.end! >= v.stop ? v.cut : undefined,
  }));
  return { frames, stems, mix, usedPads, timeline: { segments, hits } };
}

// A single pad as the device would play it on one hit (start/end, reverse, pitch, volume, pan; no looping).
export function renderPad(project: Project, pad: number): StereoBuffer {
  const p = { ...project.conf.pads[pad], loop: false };
  // Synced pads preview at the tempo of their bank (or the project tempo, if that's in use).
  const voice: Voice = { pad, start: 0, stop: Infinity, gain: p.volume / 127, note: 0, bpm: bankTempo(project.conf, Math.floor(pad / 16)) };
  const src = voiceSource(project, p, voice);
  if (!src) return stereo(0);
  const out = stereo(Math.ceil((src.end - src.start) / src.ratio) + 2);
  const n = renderVoice(project, p, voice, out, out.left.length);
  return { left: out.left.subarray(0, n), right: out.right.subarray(0, n) };
}
