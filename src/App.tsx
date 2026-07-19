import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Bot, Mic, Send, Sparkles, Square, Volume2, VolumeX, X } from 'lucide-react';
import type { MicVAD } from '@ricky0123/vad-web';
import type { ChatMessage, ChatResult, VoiceStatus } from './types';

const STORAGE_KEY = 'echo-voicechat-history-v1';
declare global {
  interface Window {
    vad?: { MicVAD: typeof MicVAD };
  }
}
const initialMessage: ChatMessage = {
  id: 'welcome', role: 'assistant', text: 'Hi, I am Echo. Start talking whenever you are ready.', createdAt: new Date().toISOString(), language: 'en',
};
function debug(event: string, details = '') {
  console.info(`[Echo] ${event}${details ? ` ${details}` : ''}`);
}

function wavFromSamples(samples: Float32Array, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => Array.from(value).forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true));
  return new Blob([buffer], { type: 'audio/wav' });
}

function getStoredMessages(): ChatMessage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) && parsed.length ? parsed : [initialMessage];
  } catch { return [initialMessage]; }
}

function labelFor(status: VoiceStatus) {
  return { idle: 'Ready to listen', listening: 'Listening', thinking: 'Echo is thinking', speaking: 'Echo is speaking', error: 'Connection issue' }[status];
}

function timeFor(iso: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function Waveform({ active }: { active: boolean }) {
  return <div className={`waveform ${active ? 'waveform-active' : ''}`} aria-hidden="true">{Array.from({ length: 34 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 45}ms` }} />)}</div>;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(getStoredMessages);
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [muted, setMuted] = useState(false);
  const [autoListen, setAutoListen] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const vadRef = useRef<MicVAD | null>(null);
  const historyRef = useRef(messages);
  const mutedRef = useRef(muted);
  const requestInFlightRef = useRef(false);
  const lastLevelUpdateRef = useRef(0);
  const autoListenRef = useRef(autoListen);

  useEffect(() => { historyRef.current = messages; localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50))); }, [messages]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { autoListenRef.current = autoListen; }, [autoListen]);
  useEffect(() => () => stopListening(), []);

  const addMessage = useCallback((message: ChatMessage) => setMessages((current) => [...current, message]), []);

  const playAudio = useCallback(async (result: ChatResult) => {
    if (mutedRef.current || !result.audio) return;
    debug('playback_start', `audio_chars=${result.audio.length}`);
    setStatus('speaking');
    const audio = new Audio(`data:${result.mimeType};base64,${result.audio}`);
    await new Promise<void>((resolve) => {
      audio.onended = () => { debug('playback_end'); setStatus((current) => current === 'speaking' ? 'listening' : current); resolve(); };
      audio.onerror = () => { setError('The reply was received, but its audio could not be played.'); setStatus('listening'); resolve(); };
      void audio.play().catch(() => { setError('The reply was received, but its audio could not be played.'); resolve(); });
    });
  }, []);

  const sendText = useCallback(async (text: string, language?: string) => {
    const normalized = text.trim();
    if (!normalized) return;
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    await vadRef.current?.pause();
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: normalized, createdAt: new Date().toISOString(), language };
    addMessage(userMessage);
    setStatus('thinking'); setError(''); setDraft('');
    try {
      debug('text_request_start', `text_chars=${normalized.length}`);
      const response = await fetch('/api/chat/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: normalized, language, history: historyRef.current }) });
      debug('text_request_response', `status=${response.status}`);
      const result = await response.json() as ChatResult & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Echo could not respond.');
      addMessage({ id: crypto.randomUUID(), role: 'assistant', text: result.assistantText, createdAt: new Date().toISOString(), language });
      await playAudio(result);
      setStatus((current) => current === 'thinking' ? 'listening' : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Echo could not respond.'); setStatus('error');
    } finally {
      requestInFlightRef.current = false;
      if (autoListenRef.current) void vadRef.current?.start();
    }
  }, [addMessage, playAudio]);

  const sendAudio = useCallback(async (blob: Blob) => {
    if (blob.size < 1800) return;
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    await vadRef.current?.pause();
    setStatus('thinking'); setError('');
    const body = new FormData();
    const extension = blob.type === 'audio/wav' ? 'wav' : 'webm';
    body.append('audio', blob, `voice-note.${extension}`);
    body.append('history', JSON.stringify(historyRef.current));
    try {
      debug('audio_request_start', `bytes=${blob.size} mime=${blob.type}`);
      const response = await fetch('/api/chat/audio', { method: 'POST', body });
      debug('audio_request_response', `status=${response.status}`);
      const result = await response.json() as ChatResult & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Echo could not understand that.');
      addMessage({ id: crypto.randomUUID(), role: 'user', text: result.transcript || '', createdAt: new Date().toISOString(), language: result.language });
      addMessage({ id: crypto.randomUUID(), role: 'assistant', text: result.assistantText, createdAt: new Date().toISOString(), language: result.language });
      await playAudio(result);
      setStatus((current) => current === 'thinking' ? 'listening' : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Voice request failed.'); setStatus('error');
    } finally {
      requestInFlightRef.current = false;
      if (autoListenRef.current) void vadRef.current?.start();
    }
  }, [addMessage, playAudio]);

  async function startListening() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support microphone access. Use a current browser over HTTPS or localhost.');
      setStatus('error');
      return;
    }
    try {
      debug('microphone_request');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true },
      });
      setError('');
      debug('microphone_granted');
      let activeStream = stream;
      let pauseStream = false;
      if (!window.vad) throw new Error('Voice activity detection assets did not load. Restart the Vite server.');
      const vad = await window.vad.MicVAD.new({
        model: 'v5',
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/ort/',
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.35,
        redemptionMs: 850,
        preSpeechPadMs: 300,
        minSpeechMs: 350,
        submitUserSpeechOnPause: false,
        getStream: async () => activeStream,
        pauseStream: async (currentStream) => {
          pauseStream = true;
          currentStream.getTracks().forEach((track) => track.stop());
        },
        resumeStream: async () => {
          if (!pauseStream) return activeStream;
          activeStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true },
          });
          pauseStream = false;
          return activeStream;
        },
        onSpeechStart: () => debug('vad_speech_start'),
        onSpeechEnd: (samples) => {
          const recording = wavFromSamples(samples);
          debug('vad_speech_end', `samples=${samples.length} bytes=${recording.size}`);
          void sendAudio(recording);
        },
        onVADMisfire: () => debug('vad_misfire'),
        onFrameProcessed: ({ isSpeech }) => {
          const now = Date.now();
          if (now - lastLevelUpdateRef.current > 120) {
            setAudioLevel(isSpeech);
            lastLevelUpdateRef.current = now;
          }
        },
      });
      vadRef.current = vad;
      await vad.start();
      setAutoListen(true); setStatus('listening'); debug('microphone_ready');
    } catch (caught) {
      const details = caught instanceof DOMException ? `${caught.name}: ${caught.message}` : String(caught);
      debug('microphone_or_vad_failed', details);
      const isPermissionError = caught instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(caught.name);
      setError(isPermissionError ? `Microphone permission failed (${details}). Allow this site to use the microphone, then try again.` : `Voice detection could not start: ${details}`);
      setStatus('error');
    }
  }

  function stopListening() {
    debug('session_stopped'); setAutoListen(false);
    void vadRef.current?.destroy(); vadRef.current = null;
    setStatus((current) => current === 'listening' ? 'idle' : current);
  }

  const clearConversation = () => { setMessages([initialMessage]); setError(''); };
  const isActive = status === 'listening' || status === 'speaking';

  return <main className="min-h-screen overflow-hidden bg-[#10131b] text-slate-100 selection:bg-teal-200 selection:text-slate-950">
    <div className="grid-noise" />
    <div className="relative mx-auto flex min-h-screen max-w-[1440px] flex-col px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <header className="flex items-center justify-between border-b border-white/10 pb-4 sm:pb-5">
        <div className="flex items-center gap-3"><div className="brand-mark"><AudioLines size={21} strokeWidth={2.5} /></div><div><p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-teal-100/55">Voice companion</p><h1 className="text-lg font-semibold tracking-wide text-white">ECHO</h1></div></div>
        <div className="flex items-center gap-2 text-xs text-slate-400"><span className="hidden sm:inline">Private conversation</span><span className="status-dot status-dot-active" /></div>
      </header>
      <section className="grid flex-1 gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-stretch lg:py-6">
        <div className="conversation-panel flex h-[min(680px,calc(100dvh-7rem))] min-h-0 flex-col overflow-hidden lg:h-[min(720px,calc(100dvh-9rem))]">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 sm:px-6"><div className="flex items-center gap-3"><span className={`status-dot ${isActive ? 'status-dot-active' : ''}`} /><div><p className="text-sm font-medium text-slate-100">Echo</p><p className="text-xs text-slate-400">{labelFor(status)}</p></div></div><button onClick={clearConversation} className="clear-button">Clear chat</button></div>
          <div className="scrollbar min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-7 sm:px-8">{messages.map((message) => <article key={message.id} className={`message-row ${message.role === 'user' ? 'message-user' : ''}`}><div className={`avatar ${message.role === 'assistant' ? 'avatar-echo' : ''}`}>{message.role === 'assistant' ? <Bot size={16} /> : 'Y'}</div><div className="max-w-[82%] sm:max-w-[76%]"><div className="mb-1.5 flex items-center gap-2 text-[11px] text-slate-500"><span className="font-medium text-slate-400">{message.role === 'assistant' ? 'Echo' : 'You'}</span><span>{timeFor(message.createdAt)}</span></div><p className={`message ${message.role === 'user' ? 'message-user-bubble' : ''}`}>{message.text}</p></div></article>)}</div>
          <div className="border-t border-white/10 bg-black/10 p-4 sm:p-5"><div className="flex items-center gap-3"><button onClick={() => autoListen ? stopListening() : void startListening()} className={`mic-button ${autoListen ? 'mic-button-active' : ''}`} title={autoListen ? 'Stop listening' : 'Start continuous listening'} aria-label={autoListen ? 'Stop listening' : 'Start continuous listening'}>{autoListen ? <Square size={17} fill="currentColor" /> : <Mic size={20} />}</button><form onSubmit={(event) => { event.preventDefault(); void sendText(draft); }} className="message-composer"><input value={draft} onChange={(event) => setDraft(event.target.value)} className="min-w-0 flex-1 bg-transparent py-3 text-sm text-white outline-none placeholder:text-slate-500" placeholder={autoListen ? 'Listening for your next turn...' : 'Write a message'} /><button disabled={!draft.trim() || status === 'thinking'} className="send-button" aria-label="Send text message"><Send size={18} /></button></form></div>{error && <div className="mt-3 flex items-center justify-between gap-3 border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-100"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button></div>}</div>
        </div>
        <aside className="live-panel relative flex min-h-[420px] flex-col overflow-hidden p-6 sm:p-7 lg:min-h-[580px]">
          <div className="flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-teal-100/60">Voice channel</span><span className="flex items-center gap-1.5 text-xs text-emerald-300"><span className="status-dot status-dot-active" />Online</span></div>
          <div className="relative flex flex-1 flex-col items-center justify-center py-8"><div className={`orbital ${isActive ? 'orbital-active' : ''}`}><div className="orbital-inner"><Sparkles size={31} /></div></div><Waveform active={isActive} /><p className="mt-7 text-sm font-medium text-slate-100">{labelFor(status)}</p><p className="mt-2 max-w-56 text-center text-xs leading-5 text-slate-500">Speak naturally. Echo sends your message after a short pause.</p>{autoListen && <p className="mt-3 font-mono text-[11px] text-teal-100/70">VOICE ACTIVITY {audioLevel.toFixed(2)}</p>}</div>
          <div className="space-y-4 border-t border-white/10 pt-5"><div className="flex items-center justify-between text-xs text-slate-400"><span>Spoken replies</span><button onClick={() => setMuted((value) => !value)} className="audio-toggle" aria-label={muted ? 'Enable spoken replies' : 'Mute spoken replies'}><span>{muted ? 'Off' : 'On'}</span>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button></div><button onClick={() => autoListen ? stopListening() : void startListening()} className={`session-button ${autoListen ? 'session-button-stop' : ''}`}>{autoListen ? <><Square size={16} fill="currentColor" /> End session</> : <><Mic size={17} /> Start session</>}</button></div>
        </aside>
      </section>
      <footer className="pt-1 text-center text-[11px] text-slate-600 sm:text-left">Your conversation is kept in this browser.</footer>
    </div>
  </main>;
}
