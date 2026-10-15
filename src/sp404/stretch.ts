// Pitch-preserving time-stretching and resampling for pads that don't use VINYL mode.
// The SP-404MKII's own algorithms (VariPhrase-based) run on a proprietary DSP we can't read, so these
// follow the behaviour the manual describes for each VARI mode rather than the exact processing:
//   Off      - plain time-domain stretching (WSOLA)
//   Backing  - keeps attacks intact: transients are copied unstretched, only the decays between them stretch
//   Ensemble - smoother, for sustained sounds: longer grains with more overlap

export interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

export enum VariMode {
  Off = 0,
  Backing = 1,
  Ensemble = 2,
}

// Resample by `ratio` (> 1 = faster and higher).
export function resample(src: Stereo, ratio: number): Stereo {
  const n = Math.max(1, Math.floor(src.left.length / ratio));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const last = src.left.length - 1;
  for (let k = 0; k < n; k++) {
    const pos = k * ratio;
    const i = Math.floor(pos);
    const j = Math.min(i + 1, last);
    const f = pos - i;
    left[k] = src.left[i] + (src.left[j] - src.left[i]) * f;
    right[k] = src.right[i] + (src.right[j] - src.right[i]) * f;
  }
  return { left, right };
}

interface WsolaSettings {
  frame: number;
  hop: number; // synthesis hop
  tolerance: number; // how far (in frames) to search for the best-matching segment
}

const OFF: WsolaSettings = { frame: 2048, hop: 1024, tolerance: 512 };
const ENSEMBLE: WsolaSettings = { frame: 4096, hop: 1024, tolerance: 1024 };
const SEARCH_STEP = 2;
const CORR_STEP = 4;

const windows = new Map<number, Float32Array>();
function hann(n: number): Float32Array {
  let w = windows.get(n);
  if (!w) windows.set(n, (w = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))));
  return w;
}

// WSOLA: overlap-add windowed grains, each taken from near its nominal position wherever it best
// continues the previous grain. Output is normalised by the summed window, so any overlap works.
function wsola(src: Stereo, outLen: number, s: WsolaSettings): Stereo {
  const len = src.left.length;
  const left = new Float32Array(outLen);
  const right = new Float32Array(outLen);
  if (len === 0 || outLen === 0) return { left, right };
  if (len < s.frame * 2) {
    const r = resample(src, len / outLen);
    return { left: r.left.subarray(0, outLen), right: r.right.subarray(0, outLen) };
  }
  const weight = new Float32Array(outLen);
  const win = hann(s.frame);
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) mono[i] = src.left[i] + src.right[i];
  const analysisHop = (s.hop * len) / outLen;
  const overlap = s.frame - s.hop;

  let prev = 0;
  for (let k = 0, out = 0; out < outLen; k++, out += s.hop) {
    let pos = Math.min(Math.round(k * analysisHop), len - 1);
    const natural = prev + s.hop;
    if (k > 0 && natural + overlap < len) {
      let best = pos;
      let bestScore = -Infinity;
      const lo = Math.max(0, pos - s.tolerance);
      const hi = Math.min(len - s.frame, pos + s.tolerance);
      for (let c = lo; c <= hi; c += SEARCH_STEP) {
        let score = 0;
        for (let i = 0; i < overlap; i += CORR_STEP) score += mono[c + i] * mono[natural + i];
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      pos = best;
    }
    prev = pos;
    for (let i = 0; i < s.frame; i++) {
      const si = pos + i;
      const o = out + i;
      if (si >= len || o >= outLen) break;
      left[o] += src.left[si] * win[i];
      right[o] += src.right[si] * win[i];
      weight[o] += win[i];
    }
  }
  for (let i = 0; i < outLen; i++) {
    if (weight[i] > 1e-6) {
      left[i] /= weight[i];
      right[i] /= weight[i];
    }
  }
  return { left, right };
}

// Onsets: frames whose energy jumps well above the recent average.
function onsets(src: Stereo): number[] {
  const hop = 512;
  const energy: number[] = [];
  for (let o = 0; o + hop <= src.left.length; o += hop) {
    let e = 0;
    for (let i = o; i < o + hop; i++) e += src.left[i] * src.left[i] + src.right[i] * src.right[i];
    energy.push(e / hop);
  }
  const found = [0];
  let avg = energy[0] ?? 0;
  for (let k = 1; k < energy.length; k++) {
    const pos = k * hop;
    if (energy[k] > avg * 4 + 1e-6 && energy[k] > energy[k - 1] * 2 && pos - found[found.length - 1] > 4096) found.push(pos);
    avg = avg * 0.8 + energy[k] * 0.2;
  }
  return found;
}

const ATTACK = 1024; // ~21 ms of each transient kept as-is
const SEAM = 64;

// Backing: segment at onsets; keep each attack unstretched and stretch only what follows it.
function backing(src: Stereo, factor: number): Stereo {
  const len = src.left.length;
  const outLen = Math.round(len * factor);
  const left = new Float32Array(outLen);
  const right = new Float32Array(outLen);
  const cuts = [...onsets(src), len];
  let out = 0;
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    const target = k === cuts.length - 2 ? outLen - out : Math.round((b - a) * factor);
    if (target <= 0) continue;
    const attack = Math.min(ATTACK, b - a, target);
    const seg = { left: new Float32Array(target), right: new Float32Array(target) };
    seg.left.set(src.left.subarray(a, a + attack));
    seg.right.set(src.right.subarray(a, a + attack));
    if (target > attack && b - (a + attack) > 0) {
      const rest = wsola({ left: src.left.subarray(a + attack, b), right: src.right.subarray(a + attack, b) }, target - attack, OFF);
      seg.left.set(rest.left, attack);
      seg.right.set(rest.right, attack);
    }
    // Short crossfade into each new segment so the joins don't click.
    for (let i = 0; i < target && out + i < outLen; i++) {
      const fade = k > 0 && i < SEAM ? i / SEAM : 1;
      left[out + i] = left[out + i] * (1 - fade) + seg.left[i] * fade;
      right[out + i] = right[out + i] * (1 - fade) + seg.right[i] * fade;
    }
    out += target;
  }
  return { left, right };
}

// Make `src` `factor` times longer without changing pitch.
export function timeStretch(src: Stereo, factor: number, mode: VariMode = VariMode.Off): Stereo {
  if (Math.abs(factor - 1) < 1e-4) return src;
  const outLen = Math.max(1, Math.round(src.left.length * factor));
  if (mode === VariMode.Backing) return backing(src, factor);
  return wsola(src, outLen, mode === VariMode.Ensemble ? ENSEMBLE : OFF);
}
