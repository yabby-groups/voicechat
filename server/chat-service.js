import OpenAI from 'openai';

const MAX_HISTORY_MESSAGES = 12;

export function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) =>
      message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string',
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({ role: message.role, content: message.text.slice(0, 4000) }));
}

export function createOpenAIClient(apiKey) {
  if (!apiKey) throw new Error('Server is missing OPENAI_API_KEY. Add it to .env and restart.');
  return new OpenAI({ apiKey });
}

async function synthesizeSpeech(client, text, language) {
  const speech = await client.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: 'coral',
    input: text,
    instructions:
      language?.startsWith('zh')
        ? 'Speak naturally in Mandarin Chinese, with a calm and warm but concise delivery.'
        : 'Speak naturally with a calm, warm, concise delivery.',
    response_format: 'mp3',
  });
  return Buffer.from(await speech.arrayBuffer()).toString('base64');
}

export async function respondToMessage({ apiKey, text, history = [], language }) {
  const client = createOpenAIClient(apiKey);
  const response = await client.responses.create({
    model: 'gpt-4.1-mini',
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
  const audio = await synthesizeSpeech(client, assistantText, language);
  return { assistantText, audio, mimeType: 'audio/mpeg' };
}

export async function transcribeAudio({ apiKey, buffer, mimetype, filename }) {
  const client = createOpenAIClient(apiKey);
  const file = new File([buffer], filename || 'speech.webm', { type: mimetype || 'audio/webm' });
  const transcript = await client.audio.transcriptions.create({
    model: 'gpt-4o-mini-transcribe',
    file,
    response_format: 'verbose_json',
  });
  return {
    text: transcript.text?.trim() || '',
    language: transcript.language || 'und',
  };
}
