import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { respondToMessage, transcribeAudio } from './chat-service.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);

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

function sendError(res, error) {
  const message = error instanceof Error ? error.message : 'Unable to complete the request.';
  res.status(message.includes('missing OPENAI_API_KEY') ? 503 : 500).json({ error: message });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.OPENAI_API_KEY) });
});

app.post('/api/chat/text', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'A text message is required.' });
  try {
    const result = await respondToMessage({
      apiKey: process.env.OPENAI_API_KEY,
      text,
      history: req.body.history,
      language: req.body.language,
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/chat/audio', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'An audio recording is required.' });
  try {
    const transcript = await transcribeAudio({
      apiKey: process.env.OPENAI_API_KEY,
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      filename: req.file.originalname,
    });
    if (!transcript.text) return res.status(422).json({ error: 'No speech was detected. Please try again.' });
    const result = await respondToMessage({
      apiKey: process.env.OPENAI_API_KEY,
      text: transcript.text,
      history: readHistory(req.body.history),
      language: transcript.language,
    });
    res.json({ ...result, transcript: transcript.text, language: transcript.language });
  } catch (error) {
    sendError(res, error);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  return sendError(res, error);
});

app.listen(port, () => console.log(`Voicechat API listening on http://localhost:${port}`));
