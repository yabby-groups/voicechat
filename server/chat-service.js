import OpenAI from 'openai';

const MAX_HISTORY_MESSAGES = 12;

function pcm16ToWavBase64(chunks, sampleRate = 24000) {
  const pcm = Buffer.concat(chunks);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav.toString('base64');
}

export function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) =>
      message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string',
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({ role: message.role, content: message.text.slice(0, 4000) }));
}

export function createOpenAIClient(apiKey, baseURL, requestTimeoutMs) {
  if (!apiKey) throw new Error('Server is missing OPENAI_API_KEY. Add it to .env and restart.');
  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    timeout: requestTimeoutMs,
    maxRetries: 0,
  });
}

async function synthesizeSpeech(client, text, language, audioModel, voice) {
  const stream = await client.chat.completions.create({
    model: audioModel,
    modalities: ['text', 'audio'],
    audio: { voice, format: 'pcm16' },
    stream: true,
    messages: [{
      role: 'user',
      content: language?.startsWith('zh')
        ? `请自然、温和地朗读以下内容，不要添加任何文字：${text}`
        : `Read the following naturally and warmly. Do not add any words: ${text}`,
    }],
  });
  const audioChunks = [];
  for await (const chunk of stream) {
    const data = chunk.choices[0]?.delta?.audio?.data;
    if (data) audioChunks.push(Buffer.from(data, 'base64'));
  }
  if (!audioChunks.length) throw new Error('The audio model did not return playable speech data.');
  return { audio: pcm16ToWavBase64(audioChunks), mimeType: 'audio/wav' };
}

export async function respondToMessage({ apiKey, baseURL, requestTimeoutMs, chatModel, audioModel, audioVoice, text, history = [], language }) {
  const client = createOpenAIClient(apiKey, baseURL, requestTimeoutMs);
  const response = await client.responses.create({
    model: chatModel,
    input: [
      {
        role: 'system',
        content:
          'You are Echo, a thoughtful voice companion. Reply in the same language as the user. Keep spoken answers concise, natural, and useful. Do not use markdown.',
      },
      ...normalizeHistory(history),
      { role: 'user', content: text },
    ],
  });
  const assistantText = response.output_text.trim();
  if (!assistantText) throw new Error('The assistant returned an empty response.');
  const speech = await synthesizeSpeech(client, assistantText, language, audioModel, audioVoice);
  return { assistantText, ...speech };
}

export async function transcribeAudio({ apiKey, baseURL, requestTimeoutMs, transcribeModel, buffer, mimetype, filename }) {
  const client = createOpenAIClient(apiKey, baseURL, requestTimeoutMs);
  const file = new File([buffer], filename || 'speech.webm', { type: mimetype || 'audio/webm' });
  const transcript = await client.audio.transcriptions.create({
    model: transcribeModel,
    file,
  });
  return {
    text: transcript.text?.trim() || '',
    language: transcript.language || 'und',
  };
}
