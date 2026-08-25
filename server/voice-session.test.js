import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceSession } from './voice-session.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('audio reply starts before asynchronous transcription completes', async () => {
  const transcript = deferred();
  const sent = [];
  const calls = [];
  const session = new VoiceSession(
    { readyState: 1, send: (event) => { if (typeof event === 'string') sent.push(JSON.parse(event)); } },
    { audioVoice: 'alloy', audioResponseMode: 'direct' },
    () => undefined,
    {
      createOpenAIClient: () => ({}),
      transcribeAudio: () => transcript.promise,
      streamAudioReply: async () => ({ assistantText: 'unused' }),
      streamAudioInputReply: async (_client, request) => {
        calls.push(request);
        return { assistantText: 'Audio reply' };
      },
    },
  );

  await session.replyToAudio([new Float32Array([0, 0.5])]);

  assert.equal(calls.length, 1);
  assert.equal(session.history[0].text, '');
  assert.equal(session.history[1].text, 'Audio reply');
  assert.deepEqual(sent.map((event) => event.type), ['turn_started', 'complete']);
  assert.equal(sent[0].turnId, sent[1].turnId);

  transcript.resolve({ text: 'Hello there', language: 'en' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.history[0].text, 'Hello there');
  assert.deepEqual(sent.map((event) => event.type), ['turn_started', 'complete', 'transcript']);
  assert.equal(sent[2].turnId, sent[0].turnId);
});

test('a failed asynchronous transcription does not cancel an audio reply', async () => {
  const session = new VoiceSession(
    { readyState: 1, send: () => undefined },
    { audioVoice: 'alloy', audioResponseMode: 'direct' },
    () => undefined,
    {
      createOpenAIClient: () => ({}),
      transcribeAudio: async () => { throw new Error('transcription unavailable'); },
      streamAudioReply: async () => ({ assistantText: 'unused' }),
      streamAudioInputReply: async () => ({ assistantText: 'Audio reply' }),
    },
  );

  await session.replyToAudio([new Float32Array([0])]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.history, [{ role: 'assistant', text: 'Audio reply' }]);
});

test('two_stage text turns use the staged reply service and stream PCM', async () => {
  const sent = [];
  const requests = [];
  const session = new VoiceSession(
    { readyState: 1, send: (event) => { if (typeof event === 'string') sent.push(JSON.parse(event)); } },
    { audioVoice: 'alloy', audioResponseMode: 'two_stage' },
    () => undefined,
    {
      createOpenAIClient: () => ({}),
      streamAudioReply: async () => { throw new Error('direct service should not run'); },
      twoStageReply: async (_client, request) => {
        requests.push(request);
        request.onAudioChunk('AQI=');
        return { assistantText: 'Staged reply' };
      },
    },
  );

  await session.receiveText({ text: 'Hello' });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].includeAudio, false);
  assert.deepEqual(session.history, [
    { role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Staged reply' },
  ]);
  assert.deepEqual(sent.map((event) => event.type), ['turn_started', 'complete']);
});

test('two_stage audio turns transcribe before using the staged reply service', async () => {
  const sent = [];
  const requests = [];
  const session = new VoiceSession(
    { readyState: 1, send: (event) => sent.push(JSON.parse(event)) },
    { audioVoice: 'alloy', audioResponseMode: 'two_stage' },
    () => undefined,
    {
      createOpenAIClient: () => ({}),
      transcribeAudio: async () => ({ text: 'Spoken request', language: 'en' }),
      streamAudioInputReply: async () => { throw new Error('direct service should not run'); },
      twoStageReply: async (_client, request) => {
        requests.push(request);
        return { assistantText: 'Staged reply' };
      },
    },
  );

  await session.replyToAudio([new Float32Array([0, 0.5])]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, 'Spoken request');
  assert.deepEqual(requests[0].history, []);
  assert.deepEqual(session.history, [
    { role: 'user', text: 'Spoken request' }, { role: 'assistant', text: 'Staged reply' },
  ]);
  assert.deepEqual(sent.map((event) => event.type), ['turn_started', 'transcript', 'complete']);
});

test('two_stage audio turns fall back to the current audio model when transcription is unavailable', async () => {
  const sent = [];
  const requests = [];
  const session = new VoiceSession(
    { readyState: 1, send: (event) => sent.push(JSON.parse(event)) },
    { audioVoice: 'alloy', audioResponseMode: 'two_stage' },
    () => undefined,
    {
      createOpenAIClient: () => ({}),
      transcribeAudio: async () => { throw new Error('model unavailable'); },
      streamAudioInputReply: async (_client, request) => {
        assert.match(request.systemInstruction, /Transcribe the user audio verbatim/);
        return { assistantText: 'Fallback transcript' };
      },
      twoStageReply: async (_client, request) => {
        requests.push(request);
        return { assistantText: 'Staged reply' };
      },
    },
  );

  await session.replyToAudio([new Float32Array([0, 0.5])]);

  assert.equal(requests[0].text, 'Fallback transcript');
  assert.deepEqual(session.history, [
    { role: 'user', text: 'Fallback transcript' }, { role: 'assistant', text: 'Staged reply' },
  ]);
  assert.deepEqual(sent.map((event) => event.type), ['turn_started', 'transcript', 'complete']);
});
