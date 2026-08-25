# Echo Voicechat

An OpenAI-backed continuous voice chat interface built with Vite, React, Tailwind CSS, and Node.js.

## Run locally

1. Copy `.env.example` to `.env`. Set `OPENAI_BASE_URL` to the Myna OpenAI-compatible API endpoint (normally ending in `/v1`); set `VITE_MYNA_BASE_URL` when the Myna login site is not inferred correctly.
2. Set the supported audio models in `.env` if your provider differs from the defaults: `gpt-4o-mini-transcribe` and `gpt-audio-mini`.
3. Run `npm install`.
4. Run `npm run dev` and open `http://localhost:5173`.

If the local API port is already in use, run `PORT=8788 VOICECHAT_API_PORT=8788 npm run dev`; Vite will proxy WebSocket traffic to that API instance.

Sign in with a Myna account before chatting. VoiceChat loads the user's active Token Base tokens and automatically creates a `voicechat-<timestamp>` token when none exists. The selected token authorizes every AI call for the WebSocket session. The chat-model selector contains only models configured for the Responses API.

Speak naturally after starting a session. The browser sends 16 kHz mono PCM16 microphone frames over one WebSocket connection; the Node service runs Silero v5 VAD and sends a turn after a short pause. The in-app audio-response selector defaults to `direct`. In `direct` mode, it sends that WAV turn to one streaming `gpt-audio-mini` request to generate both the reply text and PCM voice response, while `gpt-4o-mini-transcribe` updates the visible transcript independently. In `two_stage` mode, the service first transcribes the turn, generates a text reply with the selected Responses model, then streams synthesized PCM speech from `OPENAI_AUDIO_MODEL`.

All chat interaction uses `/api/chat/ws`. Client JSON messages initialize the session, update preferences, or submit text; microphone audio and assistant audio use binary PCM16 WebSocket frames. Server messages report readiness, speech/turn state, transcripts, completion, and errors. Assistant PCM chunks are played with Web Audio after a 120 ms buffer.

## Optional web search

Echo can use a deployment-managed Brave MCP server for read-only web search. Set `WEB_SEARCH_ENABLED=true`, the trusted HTTPS `BRAVE_MCP_SERVER_URL`, its authentication header/value, and the exact allowed search tool names in `BRAVE_MCP_ALLOWED_TOOLS`. These credentials stay on the Node server; never place them in a `VITE_` variable.

When enabled, Echo uses the two-stage Responses path for every turn so the model can call the approved search tools, then speaks the final answer with the configured audio model. The UI shows search activity, but does not expose MCP configuration or permit arbitrary tool calls.

## Commands

- `npm run dev`: start Vite and the API service together.
- `npm run build`: type-check and produce the frontend build.
- `npm test`: run server-side unit tests.
- `npm start`: run the API service on `PORT` (default `8787`).

Conversation text is retained only in this browser's local storage. The server keeps the active conversation only for the lifetime of the WebSocket connection. Audio is sent to the configured OpenAI service to create each reply and is not persisted by this application.
