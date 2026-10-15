import { test } from "node:test";
import assert from "node:assert/strict";
import { resample, timeStretch, VariMode, Stereo } from "../src/sp404/stretch.js";

const RATE = 48000;
const sine = (freq: number, frames: number, amp = 0.5): Stereo => {
  const left = Float32Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / RATE));
  return { left, right: Float32Array.from(left) };
};
// Average frequency by counting upward zero crossings away from the edges.
const freqOf = (x: Float32Array) => {
  const a = Math.floor(x.length * 0.2);
  const b = Math.floor(x.length * 0.8);
  let n = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return (n * RATE) / (b - a);
};
const rms = (x: Float32Array, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};

test("resample: ratio 2 halves the length and doubles the pitch", () => {
  const out = resample(sine(440, RATE), 2);
  assert.equal(out.left.length, RATE / 2);
  assert.ok(Math.abs(freqOf(out.left) - 880) < 10);
});

test("resample: ratio 1 is (almost) the identity, and interpolates in between", () => {
  const src = { left: Float32Array.from([0, 1, 0, -1]), right: Float32Array.from([0, 0, 0, 0]) };
  assert.deepEqual([...resample(src, 1).left], [0, 1, 0, -1]);
  assert.deepEqual([...resample(src, 0.5).left], [0, 0.5, 1, 0.5, 0, -0.5, -1, -1]);
});

for (const mode of [VariMode.Off, VariMode.Backing, VariMode.Ensemble]) {
  const name = VariMode[mode];
  for (const factor of [0.5, 0.8, 1.25, 2]) {
    test(`timeStretch (${name}, ×${factor}): exact length, same pitch, similar level`, () => {
      const src = sine(523.25, RATE);
      const out = timeStretch(src, factor, mode);
      assert.equal(out.left.length, Math.round(RATE * factor));
      assert.equal(out.right.length, out.left.length);
      const f = freqOf(out.left);
      assert.ok(Math.abs(f - 523.25) < 15, `pitch moved to ${f.toFixed(1)} Hz`);
      const level = rms(out.left, Math.floor(out.left.length * 0.2), Math.floor(out.left.length * 0.8));
      assert.ok(level > 0.25 && level < 0.45, `level ${level.toFixed(3)}`);
    });
  }
}

test("timeStretch: factor 1 returns the input untouched", () => {
  const src = sine(100, 1000);
  assert.equal(timeStretch(src, 1), src);
});

test("timeStretch: very short sounds still come out at the right length", () => {
  const out = timeStretch(sine(1000, 500), 1.7);
  assert.equal(out.left.length, 850);
});

test("timeStretch: empty input gives empty output", () => {
  const out = timeStretch({ left: new Float32Array(0), right: new Float32Array(0) }, 2);
  assert.ok(out.left.length <= 1);
});

test("Backing keeps attacks sharp: each click still starts abruptly after stretching", () => {
  // Four clicks with decaying tails, half a second apart.
  const frames = 2 * RATE;
  const left = new Float32Array(frames);
  for (let k = 0; k < 4; k++) {
    const at = k * RATE / 2;
    for (let i = 0; i < 6000; i++) left[at + i] = 0.8 * Math.exp(-i / 800) * Math.sin(i / 3);
  }
  const out = timeStretch({ left, right: Float32Array.from(left) }, 1.5, VariMode.Backing);
  assert.equal(out.left.length, 3 * RATE);
  // The first 20 ms after each stretched onset carries most of the energy of its neighbourhood.
  for (let k = 0; k < 4; k++) {
    const at = Math.round(k * 0.75 * RATE);
    const head = rms(out.left, at, at + 960);
    const before = rms(out.left, Math.max(0, at - 4000), Math.max(1, at - 1000));
    assert.ok(head > 0.2, `onset ${k} lost its attack (${head.toFixed(3)})`);
    assert.ok(head > 5 * before, `onset ${k} smeared (${head.toFixed(3)} vs ${before.toFixed(3)})`);
  }
});
