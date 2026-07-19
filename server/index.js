import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { respondToMessage, transcribeAudio } from './chat-service.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);
let requestSequence = 0;
const openAIConfig = {
  baseURL: process.env.OPENAI_BASE_URL,
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-5.6-luna',
  audioModel: process.env.OPENAI_AUDIO_MODEL || 'gpt-audio-mini',
  audioVoice: process.env.OPENAI_AUDIO_VOICE || 'alloy',
  requestTimeoutMs: Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 30000),
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function readHistory(value) {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.OPENAI_API_KEY) });
});

app.post('/api/chat/text', async (req, res) => {
  const requestId = `text-${++requestSequence}`;
  const log = requestLogger(requestId);
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'A text message is required.' });
  log('received', `text_chars=${text.length}`);
  try {
    log('response_start');
    const result = await respondToMessage({
      apiKey: process.env.OPENAI_API_KEY,
      ...openAIConfig,
      text,
      history: req.body.history,
      language: req.body.language,
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
  log('received', `bytes=${req.file.size} mime=${req.file.mimetype}`);
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
      text: transcript.text,
      history: readHistory(req.body.history),
      language: transcript.language,
    });
    log('complete', `reply_chars=${result.assistantText.length} audio_chars=${result.audio.length}`);
    res.json({ ...result, transcript: transcript.text, language: transcript.language });
  } catch (error) {
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
