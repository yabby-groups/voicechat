import {
  normalizeHistory, createOpenAIClient, streamAudioInputReply, streamAudioReply, transcribeAudio,
} from './chat-service.js';
import { pcm16ToFloat32, SileroVad, VadTurnDetector, wavFromFrames } from './vad.js';

const BUILT_IN_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);

function preferences(value, defaults) {
  const voice = value?.voice === undefined || value.voice === '' ? defaults.audioVoice : value.voice;
  const language = value?.language === 'auto' || value?.language === undefined || value.language === '' ? undefined : value.language;
  if (!BUILT_IN_VOICES.has(voice)) throw new Error('Unsupported voice selection.');
  if (language !== undefined && language !== 'zh' && language !== 'en') throw new Error('Language must be auto, zh, or en.');
  return { voice, language };
}

function historyFrom(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')
    .slice(-12)
    .map((message) => ({ role: message.role, text: message.text.slice(0, 4000) }));
}

export class VoiceSession {
  constructor(socket, config, log = () => undefined, services = {
    createOpenAIClient, streamAudioInputReply, streamAudioReply, transcribeAudio,
  }) {
    this.socket = socket;
    this.config = config;
    this.log = log;
    this.services = services;
    this.history = [];
    this.preferences = { voice: config.audioVoice, language: undefined };
    this.ready = false;
    this.busy = false;
    this.audioQueue = Promise.resolve();
    this.nextTurnId = 0;
  }

  send(event) {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(event));
  }

  sendAudio(data) {
    if (this.socket.readyState === 1) this.socket.send(Buffer.from(data, 'base64'), { binary: true });
  }

  async initialize(message) {
    this.preferences = preferences(message, this.config);
    this.history = historyFrom(message.history);
    const vad = await SileroVad.create();
    this.detector = new VadTurnDetector(vad);
    this.ready = true;
    this.send({ type: 'ready' });
    this.log('ready', `history=${this.history.length} voice=${this.preferences.voice}`);
  }

  async receive(message, isBinary) {
    if (isBinary) {
      if (!this.ready) throw new Error('Send a session message before sending audio.');
      if (this.busy) return;
      const audio = Buffer.isBuffer(message) ? message : Buffer.from(message);
      this.audioQueue = this.audioQueue.then(() => this.receiveAudio(audio));
      return this.audioQueue;
    }
    const event = JSON.parse(message.toString());
    if (event.type === 'session') return this.initialize(event);
    if (!this.ready) throw new Error('Send a session message first.');
    if (event.type === 'configure') {
      this.preferences = preferences(event, { ...this.config, audioVoice: this.preferences.voice });
      return;
    }
    if (event.type === 'reset') {
      this.history = [];
      this.detector.reset();
      return;
    }
    if (event.type === 'text') return this.receiveText(event);
    if (event.type === 'close') return this.socket.close();
    throw new Error('Unsupported WebSocket message type.');
  }

  async receiveAudio(buffer) {
    if (this.busy) return;
    const events = await this.detector.push(pcm16ToFloat32(buffer));
    for (const event of events) {
      if (event.type === 'speech_started') this.send(event);
      if (event.type === 'turn') await this.replyToAudio(event.frames);
    }
  }

  async receiveText(event) {
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text) throw new Error('A text message is required.');
    if (this.busy) return;
    this.history.push({ role: 'user', text });
    await this.reply(text, this.preferences.language);
  }

  async replyToAudio(frames) {
    this.busy = true;
    const turnId = ++this.nextTurnId;
    this.send({ type: 'turn_started', source: 'audio', turnId });
    try {
      const audio = wavFromFrames(frames);
      const userEntry = { role: 'user', text: '' };
      this.history.push(userEntry);
      this.log('transcription_start');
      void this.transcribeAudioTurn(audio, userEntry, turnId);
      const client = this.services.createOpenAIClient(
        process.env.OPENAI_API_KEY, this.config.baseURL, this.config.requestTimeoutMs,
      );
      if (this.config.audioResponseMode === 'two_stage') throw new Error('WebSocket audio requires OPENAI_AUDIO_RESPONSE_MODE=direct.');
      this.log('response_start');
      const result = await this.services.streamAudioInputReply(client, {
        ...this.config,
        audioVoice: this.preferences.voice,
        audio,
        history: this.history.slice(0, -1),
        language: this.preferences.language,
        includeAudio: false,
        onAudioChunk: (data) => this.sendAudio(data),
      });
      this.history.push({ role: 'assistant', text: result.assistantText });
      this.send({
        type: 'complete', assistantText: result.assistantText, language: this.preferences.language, turnId,
      });
      this.log('complete', `reply_chars=${result.assistantText.length}`);
    } finally {
      this.busy = false;
    }
  }

  async transcribeAudioTurn(audio, userEntry, turnId) {
    try {
      const transcript = await this.services.transcribeAudio({
        apiKey: process.env.OPENAI_API_KEY,
        ...this.config,
        buffer: audio,
        mimetype: 'audio/wav',
        filename: 'voice-turn.wav',
      });
      if (!transcript.text || !this.history.includes(userEntry)) {
        this.removeHistoryEntry(userEntry);
        return;
      }
      userEntry.text = transcript.text;
      this.send({ type: 'transcript', text: transcript.text, language: transcript.language, turnId });
    } catch (error) {
      this.removeHistoryEntry(userEntry);
      this.log('transcription_error', error instanceof Error ? error.message : String(error));
    }
  }

  removeHistoryEntry(entry) {
    const index = this.history.indexOf(entry);
    if (index >= 0) this.history.splice(index, 1);
  }

  async reply(text, language, alreadyBusy = false) {
    if (!alreadyBusy) {
      this.busy = true;
      this.send({ type: 'turn_started', source: 'text' });
    }
    try {
      const client = this.services.createOpenAIClient(process.env.OPENAI_API_KEY, this.config.baseURL, this.config.requestTimeoutMs);
      if (this.config.audioResponseMode === 'two_stage') throw new Error('WebSocket audio requires OPENAI_AUDIO_RESPONSE_MODE=direct.');
      this.log('response_start');
      const result = await this.services.streamAudioReply(client, {
        ...this.config,
        audioVoice: this.preferences.voice,
        text,
        history: this.history.slice(0, -1),
        language,
        includeAudio: false,
        onAudioChunk: (data) => this.sendAudio(data),
      });
      this.history.push({ role: 'assistant', text: result.assistantText });
      this.send({ type: 'complete', assistantText: result.assistantText, language });
      this.log('complete', `reply_chars=${result.assistantText.length}`);
    } finally {
      if (!alreadyBusy) this.busy = false;
    }
  }

  async close() {
    this.detector?.reset();
  }
}

export { normalizeHistory };
