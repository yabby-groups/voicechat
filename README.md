# Echo Voicechat

An OpenAI-backed continuous voice chat interface built with Vite, React, Tailwind CSS, and Node.js.

## Run locally

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Set the supported models in `.env` if your provider differs from the defaults: `gpt-4o-mini-transcribe`, `gpt-5.6-luna`, and `gpt-audio-mini`.
3. Run `npm install`.
3. Run `npm run dev` and open `http://localhost:5173`.

Speak naturally after starting a session. A local Silero VAD detects speech and sends a turn after a short pause. The Node service transcribes with `gpt-4o-mini-transcribe`, generates a reply with `gpt-5.6-luna`, then requests a WAV voice response from `gpt-audio-mini`.

## Commands

- `npm run dev`: start Vite and the API service together.
- `npm run build`: type-check and produce the frontend build.
- `npm test`: run server-side unit tests.
- `npm start`: run the API service on `PORT` (default `8787`).

Conversation text is retained only in this browser's local storage. Audio is sent to the configured OpenAI service to create each reply and is not persisted by this application.
