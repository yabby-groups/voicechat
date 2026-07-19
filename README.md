# Echo Voicechat

An OpenAI-backed continuous voice chat interface built with Vite, React, Tailwind CSS, and Node.js.

## Run locally

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Run `npm install`.
3. Run `npm run dev` and open `http://localhost:5173`.

Speak naturally after starting a session. Echo records when it detects speech and sends a turn after a short pause. The Node service transcribes the recording, generates a matching-language response, and returns synthesized speech.

## Commands

- `npm run dev`: start Vite and the API service together.
- `npm run build`: type-check and produce the frontend build.
- `npm test`: run server-side unit tests.
- `npm start`: run the API service on `PORT` (default `8787`).

Conversation text is retained only in this browser's local storage. Audio is sent to the configured OpenAI service to create each reply and is not persisted by this application.
