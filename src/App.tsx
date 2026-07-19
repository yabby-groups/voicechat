import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Bot, ChevronDown, CircleHelp, History, Mic, MoreHorizontal, Send, Sparkles, Square, Volume2, VolumeX, X } from 'lucide-react';
import type { ChatMessage, ChatResult, VoiceStatus } from './types';

const STORAGE_KEY = 'echo-voicechat-history-v1';
const initialMessage: ChatMessage = {
  id: 'welcome', role: 'assistant', text: 'Hi, I am Echo. Start talking whenever you are ready.', createdAt: new Date().toISOString(), language: 'en',
};

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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const detectFrameRef = useRef<number | null>(null);
  const speakingSinceRef = useRef<number | null>(null);
  const silenceSinceRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const historyRef = useRef(messages);
  const mutedRef = useRef(muted);

  useEffect(() => { historyRef.current = messages; localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50))); }, [messages]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => () => stopListening(), []);

  const addMessage = useCallback((message: ChatMessage) => setMessages((current) => [...current, message]), []);

  const playAudio = useCallback(async (result: ChatResult) => {
    if (mutedRef.current || !result.audio) return;
    setStatus('speaking');
    const audio = new Audio(`data:${result.mimeType};base64,${result.audio}`);
    audio.onended = () => setStatus((current) => current === 'speaking' ? 'listening' : current);
    audio.onerror = () => { setError('The reply was received, but its audio could not be played.'); setStatus('listening'); };
    await audio.play();
  }, []);

  const sendText = useCallback(async (text: string, language?: string) => {
    const normalized = text.trim();
    if (!normalized) return;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: normalized, createdAt: new Date().toISOString(), language };
    addMessage(userMessage);
    setStatus('thinking'); setError(''); setDraft('');
    try {
      const response = await fetch('/api/chat/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: normalized, language, history: historyRef.current }) });
      const result = await response.json() as ChatResult & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Echo could not respond.');
      addMessage({ id: crypto.randomUUID(), role: 'assistant', text: result.assistantText, createdAt: new Date().toISOString(), language });
      await playAudio(result);
      setStatus((current) => current === 'thinking' ? 'listening' : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Echo could not respond.'); setStatus('error');
    }
  }, [addMessage, playAudio]);

  const sendAudio = useCallback(async (blob: Blob) => {
    if (blob.size < 1800) return;
    setStatus('thinking'); setError('');
    const body = new FormData();
    body.append('audio', blob, 'voice-note.webm');
    body.append('history', JSON.stringify(historyRef.current));
    try {
      const response = await fetch('/api/chat/audio', { method: 'POST', body });
      const result = await response.json() as ChatResult & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Echo could not understand that.');
      addMessage({ id: crypto.randomUUID(), role: 'user', text: result.transcript || '', createdAt: new Date().toISOString(), language: result.language });
      addMessage({ id: crypto.randomUUID(), role: 'assistant', text: result.assistantText, createdAt: new Date().toISOString(), language: result.language });
      await playAudio(result);
      setStatus((current) => current === 'thinking' ? 'listening' : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Voice request failed.'); setStatus('error');
    }
  }, [addMessage, playAudio]);

  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
  }, []);

  const beginRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') return;
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
    recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
    recorder.onstop = () => { const blob = new Blob(chunksRef.current, { type: recorder.mimeType }); if (blob.size > 1800) void sendAudio(blob); };
    recorder.start(); recorderRef.current = recorder;
  }, [sendAudio]);

  const monitorVoice = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || !autoListen) return;
    const values = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(values);
    const level = values.reduce((sum, value) => sum + Math.abs(value - 128), 0) / values.length;
    const now = Date.now();
    if (level > 4.2) { silenceSinceRef.current = null; if (!speakingSinceRef.current) speakingSinceRef.current = now; if (now - speakingSinceRef.current > 150) beginRecording(); }
    else if (recorderRef.current?.state === 'recording') { if (!silenceSinceRef.current) silenceSinceRef.current = now; if (now - silenceSinceRef.current > 850) { speakingSinceRef.current = null; silenceSinceRef.current = null; finishRecording(); } }
    else speakingSinceRef.current = null;
    detectFrameRef.current = requestAnimationFrame(monitorVoice);
  }, [autoListen, beginRecording, finishRecording]);

  async function startListening() {
    if (!navigator.mediaDevices?.getUserMedia) { setError('This browser does not support microphone access.'); setStatus('error'); return; }
    try {
      setError('');
      const stream = streamRef.current || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream;
      const context = audioContextRef.current || new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser(); analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser); analyserRef.current = analyser;
      setAutoListen(true); setStatus('listening');
    } catch { setError('Microphone access was blocked. Allow access and try again.'); setStatus('error'); }
  }

  function stopListening() {
    setAutoListen(false); finishRecording();
    if (detectFrameRef.current) cancelAnimationFrame(detectFrameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null;
    void audioContextRef.current?.close(); audioContextRef.current = null; analyserRef.current = null;
    setStatus((current) => current === 'listening' ? 'idle' : current);
  }

  useEffect(() => { if (autoListen) { detectFrameRef.current = requestAnimationFrame(monitorVoice); } }, [autoListen, monitorVoice]);

  const clearConversation = () => { setMessages([initialMessage]); setError(''); };
  const isActive = status === 'listening' || status === 'speaking';

  return <main className="min-h-screen overflow-hidden bg-[#070b16] text-slate-100 selection:bg-cyan-300 selection:text-slate-950">
    <div className="grid-noise" />
    <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-5 py-5 lg:px-8">
      <header className="flex items-center justify-between border-b border-white/10 pb-5">
        <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center border border-cyan-300/50 bg-cyan-300 text-[#07121f]"><AudioLines size={22} strokeWidth={2.5} /></div><div><p className="text-xs font-medium uppercase tracking-[0.24em] text-cyan-200/70">Voice interface</p><h1 className="text-lg font-semibold tracking-wide">ECHO</h1></div></div>
        <div className="flex items-center gap-2"><button className="icon-button" title="Conversation history" aria-label="Conversation history"><History size={18} /></button><button className="icon-button" title="More options" aria-label="More options"><MoreHorizontal size={20} /></button></div>
      </header>
      <section className="grid flex-1 gap-8 py-7 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
        <div className="flex min-h-[670px] flex-col border border-white/10 bg-[#0a1020]/80 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4"><div className="flex items-center gap-3"><span className={`status-dot ${isActive ? 'status-dot-active' : ''}`} /><div><p className="text-sm font-medium">Echo</p><p className="text-xs text-slate-400">{labelFor(status)}</p></div></div><button onClick={clearConversation} className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500 transition hover:text-cyan-200">Clear</button></div>
          <div className="scrollbar flex-1 space-y-6 overflow-y-auto px-5 py-6 sm:px-8">{messages.map((message) => <article key={message.id} className={`message-row ${message.role === 'user' ? 'message-user' : ''}`}><div className={`avatar ${message.role === 'assistant' ? 'avatar-echo' : ''}`}>{message.role === 'assistant' ? <Bot size={16} /> : 'Y'}</div><div className="max-w-[78%]"><div className="mb-1 flex items-center gap-2 text-xs text-slate-500"><span>{message.role === 'assistant' ? 'Echo' : 'You'}</span><span>{timeFor(message.createdAt)}</span></div><p className={`message ${message.role === 'user' ? 'message-user-bubble' : ''}`}>{message.text}</p></div></article>)}</div>
          <div className="border-t border-white/10 p-4 sm:p-5"><div className="flex items-center gap-3"><button onClick={() => autoListen ? stopListening() : void startListening()} className={`mic-button ${autoListen ? 'mic-button-active' : ''}`} title={autoListen ? 'Stop listening' : 'Start continuous listening'}>{autoListen ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}</button><form onSubmit={(event) => { event.preventDefault(); void sendText(draft); }} className="flex min-w-0 flex-1 items-center border-b border-white/15 focus-within:border-cyan-300"><input value={draft} onChange={(event) => setDraft(event.target.value)} className="min-w-0 flex-1 bg-transparent py-3 text-sm text-white outline-none placeholder:text-slate-600" placeholder={autoListen ? 'Listening automatically...' : 'Type a message instead'} /><button disabled={!draft.trim() || status === 'thinking'} className="p-2 text-cyan-200 transition hover:text-white disabled:text-slate-700" aria-label="Send text message"><Send size={18} /></button></form></div>{error && <div className="mt-3 flex items-center justify-between gap-3 border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-100"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button></div>}</div>
        </div>
        <aside className="relative flex min-h-[670px] flex-col overflow-hidden border border-cyan-200/15 bg-[#081326] p-6">
          <div className="absolute inset-x-0 top-0 h-px bg-cyan-200/70" /><div className="flex items-center justify-between"><span className="text-xs uppercase tracking-[0.2em] text-cyan-200/70">Live channel</span><span className="flex items-center gap-1.5 text-xs text-emerald-300"><span className="status-dot status-dot-active" />Connected</span></div>
          <div className="relative flex flex-1 flex-col items-center justify-center"><div className={`orbital ${isActive ? 'orbital-active' : ''}`}><div className="orbital-inner"><Sparkles size={34} /></div></div><Waveform active={isActive} /><p className="mt-8 text-sm font-medium">{labelFor(status)}</p><p className="mt-2 max-w-52 text-center text-xs leading-5 text-slate-500">Pause naturally to send. Echo will reply in the language you speak.</p></div>
          <div className="space-y-3 border-t border-white/10 pt-5"><div className="flex items-center justify-between text-xs text-slate-400"><span>Output voice</span><button onClick={() => setMuted((value) => !value)} className="flex items-center gap-2 text-slate-200"><span>{muted ? 'Muted' : 'Enabled'}</span>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button></div><button onClick={() => autoListen ? stopListening() : void startListening()} className={`session-button ${autoListen ? 'session-button-stop' : ''}`}>{autoListen ? <><Square size={16} fill="currentColor" /> End session</> : <><Mic size={17} /> Start session</>}</button></div>
        </aside>
      </section>
      <footer className="flex items-center justify-between pt-1 text-xs text-slate-600"><span>Audio is processed only to create this reply.</span><button className="flex items-center gap-1 transition hover:text-slate-300"><CircleHelp size={14} /> Help <ChevronDown size={13} /></button></footer>
    </div>
  </main>;
}
