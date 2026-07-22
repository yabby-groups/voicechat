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
    { readyState: 1, send: (event) => sent.push(JSON.parse(event)) },
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
