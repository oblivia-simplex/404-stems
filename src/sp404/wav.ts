// Stereo WAV encoders. Stems are written as 32-bit float so they sum to the full mix without clipping.
export function encodeWavFloat(left: Float32Array, right: Float32Array, rate: number): Buffer {
  const frames = left.length;
  const buf = Buffer.alloc(44 + frames * 8);
  writeHeader(buf, frames * 8, rate, 3, 32);
  for (let i = 0, o = 44; i < frames; i++, o += 8) {
    buf.writeFloatLE(left[i], o);
    buf.writeFloatLE(right[i], o + 4);
  }
  return buf;
}

export function encodeWav16(left: Float32Array, right: Float32Array, rate: number): Buffer {
  const frames = left.length;
  const buf = Buffer.alloc(44 + frames * 4);
  writeHeader(buf, frames * 4, rate, 1, 16);
  const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0, o = 44; i < frames; i++, o += 4) {
    buf.writeInt16LE(q(left[i]), o);
    buf.writeInt16LE(q(right[i]), o + 2);
  }
  return buf;
}

function writeHeader(buf: Buffer, dataSize: number, rate: number, format: number, bits: number) {
  const blockAlign = 2 * (bits / 8);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVEfmt ", 8, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(format, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(dataSize, 40);
}
