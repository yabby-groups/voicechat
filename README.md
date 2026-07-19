# Echo Voicechat

An OpenAI-backed continuous voice chat interface built with Vite, React, Tailwind CSS, and Node.js.

## Run locally

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Set the supported models in `.env` if your provider differs from the defaults: `gpt-4o-mini-transcribe`, `gpt-5.6-luna`, and `gpt-audio-mini`.
3. Run `npm install`.
3. Run `npm run dev` and open `http://localhost:5173`.

Speak naturally after starting a session. A local Silero VAD detects speech and sends a turn after a short pause. The Node service transcribes with `gpt-4o-mini-transcribe`, then uses one streaming `gpt-audio-mini` request to generate both the reply text and WAV voice response. This avoids a separate text-generation request followed by a second speech-synthesis request. Set `OPENAI_AUDIO_RESPONSE_MODE=two_stage` only when a compatible provider cannot return text and audio together.

Voice turns use `/api/chat/audio/stream`: PCM16 chunks are sent to the browser as soon as the audio model emits them and played with Web Audio after a 120 ms buffer. Server logs include `audio_first_chunk`; measure its time from `response_start` for time-to-first-audio.

## Commands

- `npm run dev`: start Vite and the API service together.
- `npm run build`: type-check and produce the frontend build.
- `npm test`: run server-side unit tests.
- `npm start`: run the API service on `PORT` (default `8787`).

Conversation text is retained only in this browser's local storage. Audio is sent to the configured OpenAI service to create each reply and is not persisted by this application.
