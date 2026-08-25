import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistory, streamAudioInputReply, streamAudioReply, twoStageReply } from './chat-service.js';

test('normalizeHistory keeps only chat roles and bounds message text', () => {
  const output = normalizeHistory([
    { role: 'system', text: 'hidden' },
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'welcome' },
    { role: 'user', text: 'x'.repeat(5000) },
  ]);
  assert.deepEqual(output.slice(0, 2), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'welcome' },
  ]);
  assert.equal(output[2].content.length, 4000);
});

test('normalizeHistory returns no records for invalid input', () => {
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory([{ role: 'user' }]), []);
});

test('streamAudioReply collects streamed PCM and the response transcript', async () => {
  const requests = [];
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          requests.push(request);
          return (async function* () {
            yield { choices: [{ delta: { audio: { transcript: 'Hello ', data: Buffer.from([1, 2]).toString('base64') } } }] };
            yield { choices: [{ delta: { audio: { transcript: 'there.', data: Buffer.from([3, 4]).toString('base64') } } }] };
          }());
        },
      },
    },
  };

  const result = await streamAudioReply(client, {
    audioModel: 'gpt-audio-mini', audioVoice: 'alloy', text: 'Hi', history: [], language: 'en',
  });

  assert.equal(result.assistantText, 'Hello there.');
  assert.equal(result.mimeType, 'audio/wav');
  assert.ok(Buffer.from(result.audio, 'base64').subarray(0, 4).equals(Buffer.from('RIFF')));
  assert.deepEqual(requests[0].modalities, ['text', 'audio']);
  assert.equal(requests[0].audio.voice, 'alloy');
  assert.equal(requests[0].stream, true);
  assert.match(requests[0].messages[0].content, /Reply only in English/);
});

test('streamAudioReply forwards PCM chunks without assembling a WAV when streaming to a client', async () => {
  const sentChunks = [];
  const client = {
    chat: { completions: { create: async () => (async function* () {
      yield { choices: [{ delta: { audio: { transcript: 'Hello', data: 'AQI=' } } }] };
    }()) } },
  };
  const result = await streamAudioReply(client, {
    audioModel: 'gpt-audio-mini', audioVoice: 'alloy', text: 'Hi', includeAudio: false,
    onAudioChunk: (chunk) => sentChunks.push(chunk),
  });
  assert.deepEqual(sentChunks, ['AQI=']);
  assert.equal(result.assistantText, 'Hello');
  assert.equal('audio' in result, false);
});

test('streamAudioInputReply sends a WAV turn directly to the audio model', async () => {
  const requests = [];
  const client = {
    chat: { completions: { create: async (request) => {
      requests.push(request);
      return (async function* () {
        yield { choices: [{ delta: { audio: { transcript: 'Done', data: 'AQI=' } } }] };
      }());
    } } },
  };
  const audio = Buffer.from('RIFFtest');

  const result = await streamAudioInputReply(client, {
    audioModel: 'gpt-audio-mini', audioVoice: 'alloy', audio, history: [{ role: 'user', text: 'Earlier' }],
  });

  assert.equal(result.assistantText, 'Done');
  assert.deepEqual(requests[0].messages.at(-1), {
    role: 'user',
    content: [{
      type: 'input_audio',
      input_audio: { data: audio.toString('base64'), format: 'wav' },
    }],
  });
  assert.deepEqual(requests[0].messages[1], { role: 'user', content: 'Earlier' });
});

test('twoStageReply streams synthesized PCM chunks without retaining a WAV', async () => {
  const sentChunks = [];
  const client = {
    responses: { create: async () => ({ output_text: 'A staged answer.' }) },
    chat: { completions: { create: async () => (async function* () {
      yield { choices: [{ delta: { audio: { data: 'AQI=' } } }] };
    }()) } },
  };

  const result = await twoStageReply(client, {
    chatModel: 'gpt-5.6-luna', audioModel: 'gpt-audio-mini', audioVoice: 'alloy', text: 'Hi',
    includeAudio: false, onAudioChunk: (chunk) => sentChunks.push(chunk),
  });

  assert.equal(result.assistantText, 'A staged answer.');
  assert.equal('audio' in result, false);
  assert.deepEqual(sentChunks, ['AQI=']);
});

test('twoStageReply executes allowed MCP function calls before speaking the final answer', async () => {
  const requests = [];
  const calls = [];
  const client = {
    responses: { create: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          output: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"latest news"}' }],
          output_text: '',
        };
      }
      return { output: [], output_text: 'Here is the latest news.' };
    } },
    chat: { completions: { create: async () => (async function* () {
      yield { choices: [{ delta: { audio: { data: 'AQI=' } } }] };
    }()) } },
  };
  const activity = [];
  const result = await twoStageReply(client, {
    chatModel: 'gpt-5.6-luna', audioModel: 'gpt-audio-mini', audioVoice: 'alloy', text: 'What is new?',
    includeAudio: false,
    mcp: {
      functionTools: async () => [{ type: 'function', name: 'web_search', description: 'Search', parameters: { type: 'object' } }],
      call: async (name, args, onActivity) => {
        calls.push({ name, args });
        onActivity({ type: 'tool_call', label: 'Brave Search', name });
        return '{"results":["A headline"]}';
      },
      onActivity: (event) => activity.push(event),
    },
  });

  assert.equal(result.assistantText, 'Here is the latest news.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].name, 'web_search');
  assert.equal(calls[0].name, 'web_search');
  assert.deepEqual(activity, [{ type: 'tool_call', label: 'Brave Search', name: 'web_search' }]);
  assert.deepEqual(requests[1].input.at(-1), {
    type: 'function_call_output', call_id: 'call_1', output: '{"results":["A headline"]}',
  });
});
