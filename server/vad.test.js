import assert from 'node:assert/strict';
import test from 'node:test';
import { FRAME_SAMPLES, VadTurnDetector, pcm16ToFloat32, wavFromFrames } from './vad.js';

function frames(count, value = 0) {
  return Array.from({ length: count }, () => new Float32Array(FRAME_SAMPLES).fill(value));
}

test('VadTurnDetector emits one padded turn after sustained silence', async () => {
  const probabilities = [0, 0, ...Array(12).fill(0.9), ...Array(27).fill(0.1)];
  const detector = new VadTurnDetector({
    probability: async () => probabilities.shift() ?? 0,
    reset: () => undefined,
  });
  const events = [];
  for (const frame of frames(41)) events.push(...await detector.push(frame));

  assert.equal(events.filter((event) => event.type === 'speech_started').length, 1);
  const turn = events.find((event) => event.type === 'turn');
  assert.ok(turn);
  assert.ok(turn.frames.length >= 39);
});

test('VadTurnDetector rejects speech shorter than the minimum duration', async () => {
  const probabilities = [...Array(2).fill(0.9), ...Array(27).fill(0.1)];
  const detector = new VadTurnDetector({ probability: async () => probabilities.shift() ?? 0 });
  const events = [];
  for (const frame of frames(29)) events.push(...await detector.push(frame));
  assert.equal(events.some((event) => event.type === 'turn'), false);
  assert.equal(events.some((event) => event.type === 'misfire'), true);
});

test('PCM conversion and WAV wrapping preserve the 16 kHz mono contract', () => {
  const pcm = Buffer.from([0, 0, 0xff, 0x7f, 0, 0x80, 0, 0]);
  const samples = pcm16ToFloat32(pcm);
  assert.equal(samples.length, 4);
  assert.equal(samples[1], 0x7fff / 0x8000);
  assert.equal(wavFromFrames([samples]).readUInt32LE(24), 16000);
});
