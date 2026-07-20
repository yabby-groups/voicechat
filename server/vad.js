import { createRequire } from 'node:module';
import * as ort from 'onnxruntime-node';

const require = createRequire(import.meta.url);
const MODEL_PATH = require.resolve('@ricky0123/vad-web/dist/silero_vad_v5.onnx');
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;

let sessionPromise;

async function getSession() {
  sessionPromise ||= ort.InferenceSession.create(MODEL_PATH);
  return sessionPromise;
}

function newState() {
  return new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
}

export class SileroVad {
  constructor(session) {
    this.session = session;
    this.sampleRate = new ort.Tensor('int64', BigInt64Array.of(16000n), [1]);
    this.reset();
  }

  static async create() {
    return new SileroVad(await getSession());
  }

  reset() {
    this.state = newState();
  }

  async probability(frame) {
    const result = await this.session.run({
      input: new ort.Tensor('float32', frame, [1, frame.length]),
      state: this.state,
      sr: this.sampleRate,
    });
    this.state = result.stateN;
    return result.output.data[0];
  }
}

export class VadTurnDetector {
  constructor(classifier, options = {}) {
    this.classifier = classifier;
    this.positiveSpeechThreshold = options.positiveSpeechThreshold ?? 0.6;
    this.negativeSpeechThreshold = options.negativeSpeechThreshold ?? 0.35;
    this.redemptionSamples = Math.ceil((options.redemptionMs ?? 850) * SAMPLE_RATE / 1000);
    this.preSpeechFrames = Math.ceil((options.preSpeechPadMs ?? 300) * SAMPLE_RATE / 1000 / FRAME_SAMPLES);
    this.minSpeechSamples = Math.ceil((options.minSpeechMs ?? 350) * SAMPLE_RATE / 1000);
    this.reset();
  }

  reset() {
    this.pending = new Float32Array();
    this.leadingFrames = [];
    this.turnFrames = [];
    this.speaking = false;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.classifier.reset?.();
  }

  async push(samples) {
    const pending = new Float32Array(this.pending.length + samples.length);
    pending.set(this.pending);
    pending.set(samples, this.pending.length);
    this.pending = pending;
    const events = [];
    while (this.pending.length >= FRAME_SAMPLES) {
      const frame = this.pending.slice(0, FRAME_SAMPLES);
      this.pending = this.pending.slice(FRAME_SAMPLES);
      const probability = await this.classifier.probability(frame);
      if (probability >= this.positiveSpeechThreshold) {
        if (!this.speaking) {
          this.speaking = true;
          this.turnFrames = [...this.leadingFrames, frame];
          this.speechSamples = FRAME_SAMPLES;
          this.silenceSamples = 0;
          events.push({ type: 'speech_started' });
        } else {
          this.turnFrames.push(frame);
          this.speechSamples += FRAME_SAMPLES;
          this.silenceSamples = 0;
        }
        continue;
      }

      if (!this.speaking) {
        this.leadingFrames.push(frame);
        if (this.leadingFrames.length > this.preSpeechFrames) this.leadingFrames.shift();
        continue;
      }

      this.turnFrames.push(frame);
      if (probability <= this.negativeSpeechThreshold) this.silenceSamples += FRAME_SAMPLES;
      else this.silenceSamples = 0;
      if (this.silenceSamples < this.redemptionSamples) continue;

      const frames = this.turnFrames;
      const hasSpeech = this.speechSamples >= this.minSpeechSamples;
      this.reset();
      events.push(hasSpeech ? { type: 'turn', frames } : { type: 'misfire' });
    }
    return events;
  }
}

export function pcm16ToFloat32(buffer) {
  if (buffer.length % 2) throw new Error('PCM16 audio frames must contain an even number of bytes.');
  const samples = new Float32Array(buffer.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2) / 0x8000;
  }
  return samples;
}

export function wavFromFrames(frames) {
  const samples = frames.reduce((total, frame) => total + frame.length, 0);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  let offset = 44;
  for (const frame of frames) {
    for (const sample of frame) {
      wav.writeInt16LE(Math.max(-1, Math.min(1, sample)) * 0x7fff, offset);
      offset += 2;
    }
  }
  return wav;
}

export { FRAME_SAMPLES, SAMPLE_RATE };
