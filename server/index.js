import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { createOpenAIClient, respondToMessage, streamAudioReply, transcribeAudio } from './chat-service.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);
let requestSequence = 0;
const BUILT_IN_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
const openAIConfig = {
  baseURL: process.env.OPENAI_BASE_URL,
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-5.6-luna',
  audioModel: process.env.OPENAI_AUDIO_MODEL || 'gpt-audio-mini',
  audioVoice: process.env.OPENAI_AUDIO_VOICE || 'alloy',
  audioResponseMode: process.env.OPENAI_AUDIO_RESPONSE_MODE || 'direct',
  requestTimeoutMs: Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 30000),
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(process.cwd(), 'dist')));

function readHistory(value) {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function selectedVoice(value) {
  if (value === undefined || value === null || value === '') return openAIConfig.audioVoice;
  return typeof value === 'string' && BUILT_IN_VOICES.has(value) ? value : null;
}

function selectedLanguage(value) {
  if (value === undefined || value === null || value === '' || value === 'auto') return undefined;
  return value === 'zh' || value === 'en' ? value : null;
}

function requestPreferences(value) {
  const voice = selectedVoice(value?.voice);
  const language = selectedLanguage(value?.language);
  if (!voice) return { error: 'Unsupported voice selection.' };
  if (language === null) return { error: 'Language must be auto, zh, or en.' };
  return { voice, language };
}

function requestLogger(requestId) {
  const startedAt = performance.now();
  return (event, details = '') => {
    const suffix = details ? ` ${details}` : '';
    console.info(`[voicechat:${requestId}] +${(performance.now() - startedAt).toFixed(0)}ms ${event}${suffix}`);
  };
}

function sendError(res, error, log) {
  const message = error instanceof Error ? error.message : 'Unable to complete the request.';
  log?.('failed', `error=${JSON.stringify(message)}`);
  res.status(message.includes('missing OPENAI_API_KEY') ? 503 : 500).json({ error: message });
}

function writeStreamEvent(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}

function startAudioStream(res) {
  res.status(200);
  res.set({
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.OPENAI_API_KEY) });
});

app.post('/api/chat/text', async (req, res) => {
  const requestId = `text-${++requestSequence}`;
  const log = requestLogger(requestId);
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'A text message is required.' });
  const preferences = requestPreferences(req.body);
  if ('error' in preferences) return res.status(400).json({ error: preferences.error });
  log('received', `text_chars=${text.length} voice=${preferences.voice} language=${preferences.language || 'auto'}`);
  try {
    log('response_start');
    const result = await respondToMessage({
      apiKey: process.env.OPENAI_API_KEY,
      ...openAIConfig,
      audioVoice: preferences.voice,
      text,
      history: req.body.history,
      language: preferences.language,
    });
    log('complete', `reply_chars=${result.assistantText.length} audio_chars=${result.audio.length}`);
    res.json(result);
  } catch (error) {
    sendError(res, error, log);
  }
});

app.post('/api/chat/audio', upload.single('audio'), async (req, res) => {
  const requestId = `audio-${++requestSequence}`;
  const log = requestLogger(requestId);
  if (!req.file) return res.status(400).json({ error: 'An audio recording is required.' });
  const preferences = requestPreferences(req.body);
  if ('error' in preferences) return res.status(400).json({ error: preferences.error });
  log('received', `bytes=${req.file.size} mime=${req.file.mimetype} voice=${preferences.voice} language=${preferences.language || 'auto'}`);
  try {
    log('transcription_start');
    const transcript = await transcribeAudio({
      apiKey: process.env.OPENAI_API_KEY,
      ...openAIConfig,
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      filename: req.file.originalname,
    });
    log('transcription_complete', `text_chars=${transcript.text.length} language=${transcript.language}`);
    if (!transcript.text) return res.status(422).json({ error: 'No speech was detected. Please try again.' });
    log('response_start');
    const result = await respondToMessage({
      apiKey: process.env.OPENAI_API_KEY,
      ...openAIConfig,
      audioVoice: preferences.voice,
      text: transcript.text,
      history: readHistory(req.body.history),
      language: preferences.language || transcript.language,
    });
    log('complete', `reply_chars=${result.assistantText.length} audio_chars=${result.audio.length}`);
    res.json({ ...result, transcript: transcript.text, language: transcript.language });
  } catch (error) {
    sendError(res, error, log);
  }
});

app.post('/api/chat/audio/stream', upload.single('audio'), async (req, res) => {
  const requestId = `audio-stream-${++requestSequence}`;
  const log = requestLogger(requestId);
  if (!req.file) return res.status(400).json({ error: 'An audio recording is required.' });
  const preferences = requestPreferences(req.body);
  if ('error' in preferences) return res.status(400).json({ error: preferences.error });
  log('received', `bytes=${req.file.size} mime=${req.file.mimetype} voice=${preferences.voice} language=${preferences.language || 'auto'}`);
  try {
    log('transcription_start');
    const transcript = await transcribeAudio({
      apiKey: process.env.OPENAI_API_KEY,
      ...openAIConfig,
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      filename: req.file.originalname,
    });
    log('transcription_complete', `text_chars=${transcript.text.length} language=${transcript.language}`);
    if (!transcript.text) return res.status(422).json({ error: 'No speech was detected. Please try again.' });

    startAudioStream(res);
    writeStreamEvent(res, { type: 'transcript', text: transcript.text, language: transcript.language });
    log('response_start');
    const client = createOpenAIClient(
      process.env.OPENAI_API_KEY, openAIConfig.baseURL, openAIConfig.requestTimeoutMs,
    );
    if (openAIConfig.audioResponseMode === 'two_stage') {
      throw new Error('Streaming audio requires OPENAI_AUDIO_RESPONSE_MODE=direct.');
    }
    let firstAudio = true;
    const result = await streamAudioReply(client, {
      ...openAIConfig,
      audioVoice: preferences.voice,
      text: transcript.text,
      history: readHistory(req.body.history),
      language: preferences.language || transcript.language,
      includeAudio: false,
      onAudioChunk: (data) => {
        if (firstAudio) {
          firstAudio = false;
          log('audio_first_chunk');
        }
        writeStreamEvent(res, { type: 'audio', data });
      },
    });
    log('complete', `reply_chars=${result.assistantText.length}`);
    writeStreamEvent(res, { type: 'complete', assistantText: result.assistantText, language: preferences.language || transcript.language });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      writeStreamEvent(res, { type: 'error', error: error instanceof Error ? error.message : 'Unable to complete the request.' });
      res.end();
      return;
    }
    sendError(res, error, log);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  return sendError(res, error);
});

const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Voicechat API listening on http://127.0.0.1:${port} (OpenAI configured: ${Boolean(process.env.OPENAI_API_KEY)})`),
);
server.ref();
server.on('error', (error) => {
  console.error('Voicechat API server error:', error);
  process.exitCode = 1;
});
server.on('close', () => console.warn('Voicechat API server closed.'));
