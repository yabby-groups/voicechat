import 'dotenv/config';
import { createServer } from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';
import { VoiceSession } from './voice-session.js';

const app = express();
const port = Number(process.env.PORT || 8787);
let connectionSequence = 0;
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
app.use(express.static(path.join(process.cwd(), 'dist')));
app.get('/api/health', (_req, res) => res.json({ ok: true, configured: Boolean(process.env.OPENAI_API_KEY) }));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url, 'http://localhost').pathname !== '/api/chat/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request));
});

wss.on('connection', (socket) => {
  const id = `ws-${++connectionSequence}`;
  const startedAt = performance.now();
  const log = (event, details = '') => console.info(`[voicechat:${id}] +${(performance.now() - startedAt).toFixed(0)}ms ${event}${details ? ` ${details}` : ''}`);
  const session = new VoiceSession(socket, openAIConfig, log);
  socket.on('message', (data, isBinary) => {
    void session.receive(data, isBinary).catch((error) => {
      const message = error instanceof Error ? error.message : 'Unable to complete the request.';
      log('failed', `error=${JSON.stringify(message)}`);
      session.busy = false;
      session.detector?.reset();
      session.send({ type: 'error', error: message });
    });
  });
  socket.on('close', () => void session.close());
  socket.on('error', (error) => log('socket_error', error.message));
});

server.listen(port, '127.0.0.1', () => console.log(`Voicechat API listening on http://127.0.0.1:${port} (OpenAI configured: ${Boolean(process.env.OPENAI_API_KEY)})`));
server.on('error', (error) => {
  console.error('Voicechat API server error:', error);
  process.exitCode = 1;
});
