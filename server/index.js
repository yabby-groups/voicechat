import 'dotenv/config';
import { createServer } from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';
import { VoiceSession } from './voice-session.js';
import { BraveSearchMcp, braveMcpConfigFromEnv } from './mcp-service.js';

const app = express();
const port = Number(process.env.PORT || 8787);
let connectionSequence = 0;
const openAIConfig = {
  baseURL: process.env.OPENAI_BASE_URL || 'https://huabot.com/v1',
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  audioModel: process.env.OPENAI_AUDIO_MODEL || 'gpt-audio-mini',
  audioVoice: 'alloy',
  audioResponseMode: 'direct',
  requestTimeoutMs: Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 30000),
};
const braveMcpConfig = braveMcpConfigFromEnv();
const webSearch = new BraveSearchMcp(braveMcpConfig, (event, details) => console.info(`[voicechat:mcp] ${event}${details ? ` ${details}` : ''}`));
const sessionConfig = {
  ...openAIConfig,
  webSearch: braveMcpConfig.enabled ? {
    enabled: true,
    functionTools: () => webSearch.functionTools(),
    call: (...args) => webSearch.call(...args),
  } : null,
};

app.use(cors());
app.use(express.static(path.join(process.cwd(), 'dist')));
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  configured: true,
  webSearchEnabled: braveMcpConfig.enabled,
}));

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
  const session = new VoiceSession(socket, sessionConfig, log);
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

server.listen(port, '127.0.0.1', () => console.log(`Voicechat API listening on http://127.0.0.1:${port}`));
server.on('error', (error) => {
  console.error('Voicechat API server error:', error);
  process.exitCode = 1;
});
server.on('close', () => void webSearch.close());
