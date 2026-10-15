import * as fs from "fs";

// SP-404MKII sample file (.SMP, magic "RFWV"). See docs/sp404mk2-project-format.md.
// 0x200-byte header (most of it is rand() filler, not encryption), then big-endian PCM.
export const SMP_HEADER_SIZE = 0x200;

export interface Sample {
  rate: number;
  channels: number;
  // Interleaved stereo float frames in [-1, 1]; mono files are duplicated to both channels.
  left: Float32Array;
  right: Float32Array;
}

export function readSmpHeader(buf: Buffer): { rate: number; channels: number; bits: number } {
  if (buf.toString("latin1", 0, 4) !== "RFWV") throw new Error("not an RFWV sample");
  return { rate: buf.readUInt32BE(8), channels: buf.readUInt32BE(12), bits: buf.readUInt32BE(16) };
}

export function readSmp(file: string): Sample {
  const buf = fs.readFileSync(file);
  const { rate, channels, bits } = readSmpHeader(buf);
  if (bits !== 16) throw new Error(`${file}: unsupported bit depth ${bits}`);
  const frames = Math.floor((buf.length - SMP_HEADER_SIZE) / (2 * channels));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0, o = SMP_HEADER_SIZE; i < frames; i++) {
    left[i] = buf.readInt16BE(o) / 32768;
    o += 2;
    if (channels > 1) {
      right[i] = buf.readInt16BE(o) / 32768;
      o += 2 * (channels - 1);
    } else {
      right[i] = left[i];
    }
  }
  return { rate, channels, left, right };
}

// Pad start/end/loop points are byte offsets into the .SMP file.
export function byteOffsetToFrame(offset: number, channels: number): number {
  return Math.max(0, Math.floor((offset - SMP_HEADER_SIZE) / (2 * channels)));
}
