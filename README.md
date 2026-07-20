# Echo Voicechat

An OpenAI-backed continuous voice chat interface built with Vite, React, Tailwind CSS, and Node.js.

## Run locally

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Set the supported models in `.env` if your provider differs from the defaults: `gpt-4o-mini-transcribe`, `gpt-5.6-luna`, and `gpt-audio-mini`.
3. Run `npm install`.
3. Run `npm run dev` and open `http://localhost:5173`.

Speak naturally after starting a session. The browser sends 16 kHz mono PCM16 microphone frames over one WebSocket connection; the Node service runs Silero v5 VAD and sends a turn after a short pause. It transcribes with `gpt-4o-mini-transcribe`, then uses one streaming `gpt-audio-mini` request to generate both the reply text and PCM voice response. This avoids a separate text-generation request followed by a second speech-synthesis request. WebSocket audio requires `OPENAI_AUDIO_RESPONSE_MODE=direct`.

All chat interaction uses `/api/chat/ws`. Client JSON messages initialize the session, update preferences, or submit text; microphone audio and assistant audio use binary PCM16 WebSocket frames. Server messages report readiness, speech/turn state, transcripts, completion, and errors. Assistant PCM chunks are played with Web Audio after a 120 ms buffer.

## Commands

- `npm run dev`: start Vite and the API service together.
- `npm run build`: type-check and produce the frontend build.
- `npm test`: run server-side unit tests.
- `npm start`: run the API service on `PORT` (default `8787`).

Conversation text is retained only in this browser's local storage. The server keeps the active conversation only for the lifetime of the WebSocket connection. Audio is sent to the configured OpenAI service to create each reply and is not persisted by this application.
