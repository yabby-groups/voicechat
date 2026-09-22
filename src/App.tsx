import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Bot,
  LoaderCircle,
  LogIn,
  MessageSquare,
  Mic,
  Send,
  Sparkles,
  Square,
  SlidersHorizontal,
  LogOut,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { ChatMessage, VoiceStatus } from "./types";
import {
  apiKeyFor,
  beginDeviceAuthorization,
  clearAuthToken,
  createVoicechatToken,
  getCurrentUser,
  getStoredAudioResponseMode,
  getStoredModel,
  getStoredTokenId,
  listMyTokens,
  listResponseModels,
  restoreOAuthSession,
  resumeDeviceAuthorization,
  revokeOAuthSession,
  storeAudioResponseMode,
  storeModel,
  storeTokenId,
  supportsResponses,
  type MynaUser,
  type AudioResponseMode,
  type TokenBaseModel,
  type TokenBaseToken,
} from "./myna";

const STORAGE_KEY = "echo-voicechat-history-v1";
const VOICE_STORAGE_KEY = "echo-voicechat-voice-v1";
const LANGUAGE_STORAGE_KEY = "echo-voicechat-language-v1";
const PENDING_ACTION_STORAGE_KEY = "echo-voicechat-pending-action-v1";
const VOICE_OPTIONS = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
type LanguagePreference = "auto" | "zh" | "en";
type MobileTab = "voice" | "chat";
type PendingAction = { type: "send"; text: string } | { type: "voice" };
const initialMessage: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text: "Hi, I am Echo. Start talking whenever you are ready.",
  createdAt: new Date().toISOString(),
  language: "en",
};
function getStoredMessages(): ChatMessage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) && parsed.length ? parsed : [initialMessage];
  } catch {
    return [initialMessage];
  }
}

function getStoredVoice() {
  const voice = localStorage.getItem(VOICE_STORAGE_KEY);
  return VOICE_OPTIONS.find((option) => option === voice) || "alloy";
}

function getStoredLanguage(): LanguagePreference {
  const language = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return language === "zh" || language === "en" ? language : "auto";
}

function getStoredPendingAction(): PendingAction | null {
  try {
    const action = JSON.parse(
      sessionStorage.getItem(PENDING_ACTION_STORAGE_KEY) || "null",
    ) as Partial<PendingAction> | null;
    if (action?.type === "voice") return { type: "voice" };
    if (
      action?.type === "send" &&
      typeof action.text === "string" &&
      action.text.trim()
    ) {
      return { type: "send", text: action.text };
    }
  } catch {
    // Ignore malformed session state from an interrupted authorization.
  }
  sessionStorage.removeItem(PENDING_ACTION_STORAGE_KEY);
  return null;
}

function labelFor(status: VoiceStatus, toolActivity = "") {
  if (toolActivity) return toolActivity;
  return {
    idle: "Ready to listen",
    listening: "Listening",
    thinking: "Echo is thinking",
    speaking: "Echo is speaking",
    error: "Connection issue",
  }[status];
}

function timeFor(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function Waveform({ status }: { status: VoiceStatus }) {
  const active =
    status === "listening" || status === "thinking" || status === "speaking";
  return (
    <div
      className={`waveform waveform-${status} ${active ? "waveform-active" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: 34 }, (_, i) => (
        <i key={i} style={{ animationDelay: `${i * 45}ms` }} />
      ))}
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(getStoredMessages);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [muted, setMuted] = useState(false);
  const [voice, setVoice] = useState(getStoredVoice);
  const [languagePreference, setLanguagePreference] =
    useState<LanguagePreference>(getStoredLanguage);
  const [autoListen, setAutoListen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("voice");
  const [isStarting, setIsStarting] = useState(false);
  const [startupProgress, setStartupProgress] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [authToken, setAuthToken] = useState("");
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<MynaUser | null>(null);
  const [apiTokens, setApiTokens] = useState<TokenBaseToken[]>([]);
  const [models, setModels] = useState<TokenBaseModel[]>([]);
  const [selectedTokenId, setSelectedTokenId] = useState(getStoredTokenId);
  const [selectedModel, setSelectedModel] = useState(getStoredModel);
  const [audioResponseMode, setAudioResponseMode] = useState<AudioResponseMode>(
    () => getStoredAudioResponseMode() || "direct",
  );
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountError, setAccountError] = useState("");
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [toolActivity, setToolActivity] = useState("");
  const historyRef = useRef(messages);
  const mutedRef = useRef(muted);
  const startingRef = useRef(false);
  const autoListenRef = useRef(autoListen);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackEndsAtRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const socketReadyRef = useRef<Promise<void> | null>(null);
  const resolveReadyRef = useRef<(() => void) | null>(null);
  const rejectReadyRef = useRef<((error: Error) => void) | null>(null);
  const assistantMessageIdsByTurnRef = useRef(new Map<number, string>());
  const intentionalCloseRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const captureContextRef = useRef<AudioContext | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const pendingActionRef = useRef<PendingAction | null>(
    getStoredPendingAction(),
  );
  const loginInProgressRef = useRef(false);
  const selectedToken =
    apiTokens.find((token) => token.id === selectedTokenId) || null;
  const userName =
    user?.profile?.nick_name || user?.nick_name || user?.name || "Myna account";
  const userInitial = userName.trim().charAt(0).toUpperCase() || "M";
  const userAvatarUrl = user?.profile?.avatar_url?.trim();
  const effectiveAudioResponseMode: AudioResponseMode = webSearchEnabled
    ? "two_stage"
    : audioResponseMode;
  const canStartSession = Boolean(
    selectedToken &&
    !accountLoading &&
    (effectiveAudioResponseMode === "direct" || selectedModel),
  );
  const canRequestSession =
    authReady && (authToken ? canStartSession : !loginInProgress);

  useEffect(() => {
    historyRef.current = messages;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50)));
  }, [messages]);
  useEffect(() => {
    localStorage.setItem(VOICE_STORAGE_KEY, voice);
  }, [voice]);
  useEffect(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference);
  }, [languagePreference]);
  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  useEffect(() => {
    autoListenRef.current = autoListen;
  }, [autoListen]);
  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen]);
  useEffect(() => {
    let active = true;
    const restoreAuthorization = async () => {
      try {
        const session = await restoreOAuthSession();
        if (session) {
          if (active) setAuthToken(session.accessToken);
          return;
        }
        const pendingSession = await resumeDeviceAuthorization();
        if (pendingSession && active) setAuthToken(pendingSession.accessToken);
      } catch (caught) {
        pendingActionRef.current = null;
        sessionStorage.removeItem(PENDING_ACTION_STORAGE_KEY);
        if (active) {
          setAccountError(
            caught instanceof Error
              ? caught.message
              : "Unable to restore authorization.",
          );
        }
      } finally {
        if (active) setAuthReady(true);
      }
    };
    void restoreAuthorization();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!authReady) return;
    if (!authToken) {
      setUser(null);
      setApiTokens([]);
      setModels([]);
      setAccountLoading(false);
      return;
    }
    let active = true;
    const loadAccount = async () => {
      setAccountLoading(true);
      setAccountError("");
      try {
        const [currentUser, tokenResult, modelResult] = await Promise.all([
          getCurrentUser(authToken),
          listMyTokens(authToken),
          listResponseModels().catch(() => ({ models: [] })),
        ]);
        let tokens = (tokenResult.tokens || []).filter(
          (token) => token.status === 1 && token.token_key,
        );
        if (tokens.length === 0) {
          const created = await createVoicechatToken(authToken);
          if (!created.token?.token_key)
            throw new Error("Token creation completed without a token key.");
          tokens = [created.token];
        }
        const responseModels = (modelResult.models || []).filter(
          (model) =>
            Number(model.enabled) === 1 &&
            Boolean(model.alias) &&
            supportsResponses(model),
        );
        if (!active) return;
        setUser(currentUser);
        setApiTokens(tokens);
        setModels(responseModels);
        const nextToken = tokens.some((token) => token.id === selectedTokenId)
          ? selectedTokenId
          : tokens[0].id;
        const nextModel = responseModels.some(
          (model) => model.alias === selectedModel,
        )
          ? selectedModel
          : responseModels[0]?.alias || "";
        setSelectedTokenId(nextToken);
        setSelectedModel(nextModel);
        storeTokenId(nextToken);
        storeModel(nextModel);
      } catch (caught) {
        if (!active) return;
        const message =
          caught instanceof Error
            ? caught.message
            : "Unable to load your Myna account.";
        if (message === "Unauthorized") {
          clearAuthToken();
          setAuthToken("");
        } else {
          setAccountError(message);
        }
      } finally {
        if (active) setAccountLoading(false);
      }
    };
    void loadAccount();
    return () => {
      active = false;
    };
  }, [authReady, authToken]);
  useEffect(() => {
    let active = true;
    void fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((health: { webSearchEnabled?: boolean } | null) => {
        if (active) setWebSearchEnabled(Boolean(health?.webSearchEnabled));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const addMessage = useCallback(
    (message: ChatMessage, beforeMessageId?: string) => {
      setMessages((current) => {
        const beforeIndex = beforeMessageId
          ? current.findIndex((item) => item.id === beforeMessageId)
          : -1;
        if (beforeIndex < 0) return [...current, message];
        return [
          ...current.slice(0, beforeIndex),
          message,
          ...current.slice(beforeIndex),
        ];
      });
    },
    [],
  );

  const stopMicrophone = useCallback(() => {
    captureNodeRef.current?.disconnect();
    captureNodeRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void captureContextRef.current?.close();
    captureContextRef.current = null;
    setAudioLevel(0);
  }, []);

  const queuePcmAudio = useCallback(async (pcm: ArrayBuffer) => {
    if (mutedRef.current || pcm.byteLength < 2) return;
    const context =
      playbackContextRef.current || new AudioContext({ sampleRate: 24000 });
    playbackContextRef.current = context;
    if (context.state === "suspended") await context.resume();
    const audioBuffer = context.createBuffer(
      1,
      Math.floor(pcm.byteLength / 2),
      24000,
    );
    const view = new DataView(pcm);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 0x8000;
    }
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const startAt = Math.max(
      context.currentTime + 0.12,
      playbackEndsAtRef.current,
    );
    source.start(startAt);
    playbackEndsAtRef.current = startAt + audioBuffer.duration;
    setStatus("speaking");
  }, []);

  const waitForQueuedAudio = useCallback(async () => {
    const context = playbackContextRef.current;
    if (!context || playbackEndsAtRef.current <= context.currentTime) return;
    const delayMs = Math.ceil(
      (playbackEndsAtRef.current - context.currentTime) * 1000,
    );
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }, []);

  const connectSocket = useCallback(async () => {
    if (socketReadyRef.current) return socketReadyRef.current;
    if (
      !selectedToken ||
      (effectiveAudioResponseMode === "two_stage" && !selectedModel)
    ) {
      throw new Error(
        "Choose an API token and, for two-stage replies, a Responses chat model first.",
      );
    }
    assistantMessageIdsByTurnRef.current.clear();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/chat/ws`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socketReadyRef.current = new Promise<void>((resolve, reject) => {
      resolveReadyRef.current = resolve;
      rejectReadyRef.current = reject;
    });
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "session",
          voice,
          language: languagePreference,
          history: historyRef.current,
          apiKey: apiKeyFor(selectedToken),
          chatModel:
            effectiveAudioResponseMode === "two_stage" ? selectedModel : "",
          audioResponseMode: effectiveAudioResponseMode,
        }),
      );
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        void queuePcmAudio(event.data as ArrayBuffer);
        return;
      }
      const message = JSON.parse(event.data) as {
        type: string;
        text?: string;
        assistantText?: string;
        language?: string;
        error?: string;
        turnId?: number;
        label?: string;
      };
      if (message.type === "ready") {
        resolveReadyRef.current?.();
        resolveReadyRef.current = null;
        return;
      }
      if (message.type === "speech_started") {
        setAudioLevel(1);
        return;
      }
      if (message.type === "turn_started") {
        stopMicrophone();
        playbackEndsAtRef.current = 0;
        setStatus("thinking");
        return;
      }
      if (message.type === "tool_call") {
        setToolActivity(
          message.label
            ? `Searching with ${message.label}`
            : "Searching the web",
        );
        return;
      }
      if (message.type === "transcript" && message.text) {
        const messageId = crypto.randomUUID();
        addMessage(
          {
            id: messageId,
            role: "user",
            text: message.text,
            createdAt: new Date().toISOString(),
            language: message.language,
          },
          message.turnId === undefined
            ? undefined
            : assistantMessageIdsByTurnRef.current.get(message.turnId),
        );
        return;
      }
      if (message.type === "complete" && message.assistantText) {
        setToolActivity("");
        const messageId = crypto.randomUUID();
        addMessage({
          id: messageId,
          role: "assistant",
          text: message.assistantText,
          createdAt: new Date().toISOString(),
          language: message.language,
        });
        if (message.turnId !== undefined) {
          assistantMessageIdsByTurnRef.current.set(message.turnId, messageId);
        }
        void waitForQueuedAudio().then(() => {
          if (autoListenRef.current) void startMicrophone();
          setStatus(autoListenRef.current ? "listening" : "idle");
        });
        return;
      }
      if (message.type === "error") {
        setToolActivity("");
        setError(message.error || "Voice request failed.");
        setStatus("error");
      }
    };
    socket.onerror = () =>
      rejectReadyRef.current?.(new Error("WebSocket connection failed."));
    socket.onclose = () => {
      socketRef.current = null;
      socketReadyRef.current = null;
      rejectReadyRef.current?.(new Error("Voice connection closed."));
      rejectReadyRef.current = null;
      if (!intentionalCloseRef.current) {
        stopMicrophone();
        setAutoListen(false);
        setError("Voice connection closed.");
        setStatus("error");
      }
      intentionalCloseRef.current = false;
    };
    return socketReadyRef.current;
  }, [
    addMessage,
    languagePreference,
    queuePcmAudio,
    stopMicrophone,
    selectedModel,
    selectedToken,
    effectiveAudioResponseMode,
    voice,
    waitForQueuedAudio,
  ]);

  const startMicrophone = useCallback(async () => {
    if (
      streamRef.current ||
      !socketRef.current ||
      socketRef.current.readyState !== WebSocket.OPEN
    )
      return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const worklet = `class PcmCapture extends AudioWorkletProcessor { constructor(){super();this.samples=[];this.position=0;this.step=sampleRate/16000;} process(inputs){const input=inputs[0][0];if(!input)return true;while(this.position<input.length){this.samples.push(input[Math.floor(this.position)]||0);this.position+=this.step;}this.position-=input.length;while(this.samples.length>=320){const chunk=this.samples.splice(0,320);const out=new Int16Array(320);for(let i=0;i<out.length;i++)out[i]=Math.max(-1,Math.min(1,chunk[i]))*0x7fff;this.port.postMessage(out.buffer,[out.buffer]);}return true;} } registerProcessor('pcm-capture',PcmCapture);`;
    const module = URL.createObjectURL(
      new Blob([worklet], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(module);
      const node = new AudioWorkletNode(context, "pcm-capture");
      node.port.onmessage = (event) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(event.data);
      };
      source.connect(node);
      node.connect(context.destination);
      streamRef.current = stream;
      captureContextRef.current = context;
      captureNodeRef.current = node;
    } finally {
      URL.revokeObjectURL(module);
    }
  }, []);

  const startListening = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    setStartupProgress(20);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)
        throw new Error("This browser does not support microphone streaming.");
      await connectSocket();
      setStartupProgress(65);
      await startMicrophone();
      setAutoListen(true);
      setStatus("listening");
      setError("");
      setStartupProgress(100);
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Microphone could not start.";
      stopMicrophone();
      setError(message);
      setStatus("error");
      setStartupProgress(0);
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [connectSocket, startMicrophone, stopMicrophone]);

  const stopListening = useCallback(() => {
    setAutoListen(false);
    autoListenRef.current = false;
    stopMicrophone();
    intentionalCloseRef.current = true;
    socketRef.current?.close();
    setStatus("idle");
  }, [stopMicrophone]);

  useEffect(() => () => stopListening(), [stopListening]);
  useEffect(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: "configure",
          voice,
          language: languagePreference,
        }),
      );
  }, [languagePreference, voice]);

  const closeForConfigurationChange = useCallback(() => {
    if (!socketRef.current) return;
    stopMicrophone();
    intentionalCloseRef.current = true;
    socketRef.current.close();
    setAutoListen(false);
    setStatus("idle");
  }, [stopMicrophone]);

  const changeToken = (tokenId: number) => {
    setSelectedTokenId(tokenId);
    storeTokenId(tokenId);
    closeForConfigurationChange();
  };

  const changeModel = (model: string) => {
    setSelectedModel(model);
    storeModel(model);
    closeForConfigurationChange();
  };

  const changeAudioResponseMode = (mode: AudioResponseMode) => {
    setAudioResponseMode(mode);
    storeAudioResponseMode(mode);
    closeForConfigurationChange();
  };

  const login = async () => {
    if (authToken || loginInProgressRef.current) return;
    loginInProgressRef.current = true;
    setLoginInProgress(true);
    setAccountError("");
    const inWeChat = /MicroMessenger/i.test(navigator.userAgent);
    const loginWindow = inWeChat ? null : window.open("", "_blank");
    const useSameTab = inWeChat || !loginWindow;
    let authorization;
    try {
      authorization = await beginDeviceAuthorization(
        useSameTab ? "return" : undefined,
      );
    } catch (error) {
      loginWindow?.close();
      loginInProgressRef.current = false;
      setLoginInProgress(false);
      throw error;
    }
    if (useSameTab) {
      window.location.assign(
        authorization.verificationUriComplete || authorization.verificationUri,
      );
      return;
    }
    loginWindow.location.replace(
      authorization.verificationUriComplete || authorization.verificationUri,
    );
    try {
      const session = await resumeDeviceAuthorization();
      if (session) setAuthToken(session.accessToken);
    } finally {
      loginInProgressRef.current = false;
      setLoginInProgress(false);
    }
  };

  const rememberPendingAction = (action: PendingAction) => {
    pendingActionRef.current = action;
    sessionStorage.setItem(PENDING_ACTION_STORAGE_KEY, JSON.stringify(action));
  };

  const beginLogin = () => {
    void login().catch((caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to start authorization.",
      );
    });
  };

  const logout = () => {
    stopListening();
    void revokeOAuthSession();
    setAuthToken("");
    setAccountError("");
  };

  const sendText = useCallback(
    async (text: string) => {
      const normalized = text.trim();
      if (!normalized || status === "thinking" || status === "speaking") return;
      try {
        await connectSocket();
        stopMicrophone();
        addMessage({
          id: crypto.randomUUID(),
          role: "user",
          text: normalized,
          createdAt: new Date().toISOString(),
          language:
            languagePreference === "auto" ? undefined : languagePreference,
        });
        socketRef.current?.send(
          JSON.stringify({ type: "text", text: normalized }),
        );
        setDraft("");
        setError("");
        setStatus("thinking");
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Voice connection failed.",
        );
        setStatus("error");
      }
    },
    [addMessage, connectSocket, languagePreference, status, stopMicrophone],
  );

  const requestText = (text: string) => {
    const normalized = text.trim();
    if (!normalized || status === "thinking" || status === "speaking") return;
    if (authToken && canStartSession) {
      void sendText(normalized);
      return;
    }
    rememberPendingAction({ type: "send", text: normalized });
    if (!authToken) beginLogin();
  };

  const requestListening = () => {
    if (autoListen) {
      stopListening();
      return;
    }
    if (authToken && canStartSession) {
      void startListening();
      return;
    }
    rememberPendingAction({ type: "voice" });
    if (!authToken) beginLogin();
  };

  useEffect(() => {
    if (!authReady || !authToken || !canStartSession) return;
    const action = pendingActionRef.current;
    if (!action) return;
    pendingActionRef.current = null;
    sessionStorage.removeItem(PENDING_ACTION_STORAGE_KEY);
    if (action.type === "send") void sendText(action.text);
    else void startListening();
  }, [authReady, authToken, canStartSession, sendText, startListening]);

  const clearConversation = () => {
    setMessages([initialMessage]);
    setError("");
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(JSON.stringify({ type: "reset" }));
  };
  const isActive = status === "listening" || status === "speaking";

  return (
    <main className="voice-app min-h-screen overflow-x-hidden bg-[#10131b] text-slate-100 selection:bg-teal-200 selection:text-slate-950">
      <div className="grid-noise" />
      <div className="voicechat-shell relative mx-auto flex min-h-screen max-w-[1440px] flex-col px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4 sm:pb-5">
          <div className="flex items-center gap-3">
            <div className="brand-mark">
              <AudioLines size={21} strokeWidth={2.5} />
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-teal-100/55">
                Voice companion
              </p>
              <h1 className="text-lg font-semibold tracking-wide text-white">
                ECHO
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="privacy-notice">
              Your conversation is kept in this browser.
            </span>
            {authToken ? (
              <>
                <span className="account-identity" title={userName}>
                  <span className="account-avatar" aria-hidden="true">
                    {userAvatarUrl ? (
                      <img src={userAvatarUrl} alt="" />
                    ) : (
                      userInitial
                    )}
                  </span>
                  <span className="hidden sm:inline">{userName}</span>
                </span>
                <span className="status-dot status-dot-active" />
                <button
                  className="settings-button"
                  onClick={() => setSettingsOpen(true)}
                  aria-controls="voice-settings"
                  aria-expanded={settingsOpen}
                  aria-label="Open settings"
                  title="Settings"
                >
                  <SlidersHorizontal size={16} />
                </button>
                <button
                  className="logout-button"
                  onClick={logout}
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut size={16} />
                </button>
              </>
            ) : (
              <button
                className="login-button"
                onClick={beginLogin}
                disabled={!authReady || loginInProgress}
              >
                <LogIn size={16} /> Login
              </button>
            )}
          </div>
        </header>
        <div
          className="mobile-tabs"
          role="tablist"
          aria-label="Voicechat views"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "voice"}
            aria-controls="voice-panel"
            className={mobileTab === "voice" ? "mobile-tab-active" : ""}
            onClick={() => setMobileTab("voice")}
          >
            <AudioLines size={17} /> Voice
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "chat"}
            aria-controls="chat-panel"
            className={mobileTab === "chat" ? "mobile-tab-active" : ""}
            onClick={() => setMobileTab("chat")}
          >
            <MessageSquare size={17} /> Chat
          </button>
        </div>
        <section className="voicechat-content grid flex-1 gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-stretch lg:py-6">
          <div
            id="chat-panel"
            role="tabpanel"
            aria-label="Chat"
            className={`conversation-panel mobile-tab-panel flex h-[min(680px,calc(100dvh-7rem))] min-h-0 flex-col overflow-hidden lg:h-[min(720px,calc(100dvh-9rem))] ${mobileTab === "chat" ? "mobile-tab-visible" : ""}`}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 sm:px-6">
              <div className="flex items-center gap-3">
                <span
                  className={`status-dot ${isActive ? "status-dot-active" : ""}`}
                />
                <div>
                  <p className="text-sm font-medium text-slate-100">Echo</p>
                  <p className="text-xs text-slate-400">
                    {labelFor(status, toolActivity)}
                  </p>
                </div>
              </div>
              <button onClick={clearConversation} className="clear-button">
                Clear chat
              </button>
            </div>
            <div
              ref={messageListRef}
              className="scrollbar min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-7 sm:px-8"
            >
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`message-row ${message.role === "user" ? "message-user" : ""}`}
                >
                  <div
                    className={`avatar ${message.role === "assistant" ? "avatar-echo" : ""}`}
                  >
                    {message.role === "assistant" ? <Bot size={16} /> : "Y"}
                  </div>
                  <div className="max-w-[82%] sm:max-w-[76%]">
                    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-slate-500">
                      <span className="font-medium text-slate-400">
                        {message.role === "assistant" ? "Echo" : "You"}
                      </span>
                      <span>{timeFor(message.createdAt)}</span>
                    </div>
                    <p
                      className={`message ${message.role === "user" ? "message-user-bubble" : ""}`}
                    >
                      {message.text}
                    </p>
                  </div>
                </article>
              ))}
            </div>
            <div className="border-t border-white/10 bg-black/10 p-4 sm:p-5">
              <div className="flex items-center gap-3">
                <button
                  disabled={isStarting || !canRequestSession}
                  onClick={requestListening}
                  className={`mic-button ${autoListen ? "mic-button-active" : ""}`}
                  title={
                    autoListen ? "Stop listening" : "Start continuous listening"
                  }
                  aria-label={
                    autoListen ? "Stop listening" : "Start continuous listening"
                  }
                >
                  {isStarting ? (
                    <LoaderCircle size={19} className="animate-spin" />
                  ) : autoListen ? (
                    <Square size={17} fill="currentColor" />
                  ) : (
                    <Mic size={20} />
                  )}
                </button>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    requestText(draft);
                  }}
                  className="message-composer"
                >
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    className="min-w-0 flex-1 bg-transparent py-3 text-sm text-white outline-none placeholder:text-slate-500"
                    placeholder={
                      isStarting
                        ? `Loading voice detection... ${startupProgress}%`
                        : autoListen
                          ? "Listening for your next turn..."
                          : "Write a message"
                    }
                  />
                  <button
                    disabled={
                      !draft.trim() ||
                      status === "thinking" ||
                      isStarting ||
                      !canRequestSession
                    }
                    className="send-button"
                    aria-label="Send text message"
                  >
                    <Send size={18} />
                  </button>
                </form>
              </div>
              {error && (
                <div className="mt-3 flex items-center justify-between gap-3 border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
                  <span>{error}</span>
                  <button
                    onClick={() => setError("")}
                    aria-label="Dismiss error"
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
            </div>
          </div>
          <aside
            id="voice-panel"
            role="tabpanel"
            aria-label="Voice"
            className={`live-panel mobile-tab-panel relative flex min-h-[420px] flex-col overflow-hidden p-6 sm:p-7 lg:min-h-[580px] ${mobileTab === "voice" ? "mobile-tab-visible" : ""}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-teal-100/60">
                Voice channel
              </span>
              <span className="flex items-center gap-1.5 text-xs text-emerald-300">
                <span className="status-dot status-dot-active" />
                Online
              </span>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="settings-button mobile-settings-button"
              aria-controls="voice-settings"
              aria-expanded={settingsOpen}
              aria-label="Open voice settings"
              title="Voice settings"
            >
              <SlidersHorizontal size={18} />
            </button>
            <div className="relative flex flex-1 flex-col items-center justify-center py-8">
              <div className={`orbital ${isActive ? "orbital-active" : ""}`}>
                <div className="orbital-inner">
                  <Sparkles size={31} />
                </div>
              </div>
              <Waveform status={status} />
              <p className="mt-7 text-sm font-medium text-slate-100">
                {isStarting
                  ? "Starting microphone..."
                  : labelFor(status, toolActivity)}
              </p>
              <p className="mt-2 max-w-56 text-center text-xs leading-5 text-slate-500">
                {isStarting
                  ? "Requesting permission and loading voice detection."
                  : "Speak naturally. Echo sends your message after a short pause."}
              </p>
              {isStarting && (
                <div className="mt-5 w-56">
                  <div className="mb-2 flex justify-between font-mono text-[10px] uppercase tracking-wider text-teal-100/70">
                    <span>Loading VAD</span>
                    <span>{startupProgress}%</span>
                  </div>
                  <div className="h-1 overflow-hidden bg-white/10">
                    <div
                      className="h-full bg-teal-300 transition-all duration-300"
                      style={{ width: `${startupProgress}%` }}
                    />
                  </div>
                </div>
              )}
              {autoListen && (
                <p className="mt-3 font-mono text-[11px] text-teal-100/70">
                  VOICE ACTIVITY {audioLevel.toFixed(2)}
                </p>
              )}
              <button
                disabled={isStarting || !canRequestSession}
                onClick={requestListening}
                className={`mobile-session-button ${autoListen ? "session-button-stop" : ""}`}
              >
                {isStarting ? (
                  <>
                    <LoaderCircle size={17} className="animate-spin" />{" "}
                    Starting... {startupProgress}%
                  </>
                ) : autoListen ? (
                  <>
                    <Square size={16} fill="currentColor" /> End session
                  </>
                ) : (
                  <>
                    <Mic size={17} /> Start session
                  </>
                )}
              </button>
            </div>
            <button
              disabled={isStarting || !canRequestSession}
              onClick={requestListening}
              className={`session-button main-session-button ${autoListen ? "session-button-stop" : ""}`}
            >
              {isStarting ? (
                <>
                  <LoaderCircle size={17} className="animate-spin" />{" "}
                  Starting... {startupProgress}%
                </>
              ) : autoListen ? (
                <>
                  <Square size={16} fill="currentColor" /> End session
                </>
              ) : (
                <>
                  <Mic size={17} /> Start session
                </>
              )}
            </button>
            <div
              id="voice-settings"
              className={`voice-controls space-y-4 border-t border-white/10 pt-5 ${settingsOpen ? "voice-controls-open" : ""}`}
              aria-label="Voice settings"
            >
              <div className="voice-settings-drawer-header">
                <span>Voice settings</span>
                <button
                  onClick={() => setSettingsOpen(false)}
                  aria-label="Close voice settings"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="voice-settings">
                <label>
                  <span>Audio response</span>
                  <select
                    value={effectiveAudioResponseMode}
                    onChange={(event) =>
                      changeAudioResponseMode(
                        event.target.value as AudioResponseMode,
                      )
                    }
                    disabled={isStarting || webSearchEnabled}
                  >
                    <option value="direct">Direct audio</option>
                    <option value="two_stage">Two-stage Responses</option>
                  </select>
                </label>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Spoken replies</span>
                <button
                  onClick={() => setMuted((value) => !value)}
                  className="audio-toggle"
                  aria-label={
                    muted ? "Enable spoken replies" : "Mute spoken replies"
                  }
                >
                  <span>{muted ? "Off" : "On"}</span>
                  {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                </button>
              </div>
              <div className="voice-settings">
                <label>
                  <span>API token</span>
                  <select
                    value={selectedTokenId}
                    onChange={(event) =>
                      changeToken(Number(event.target.value))
                    }
                    disabled={isStarting || apiTokens.length === 0}
                  >
                    {apiTokens.map((token) => (
                      <option key={token.id} value={token.id}>
                        {token.token_name || `token-${token.id}`}
                      </option>
                    ))}
                  </select>
                </label>
                {effectiveAudioResponseMode === "two_stage" && (
                  <label>
                    <span>Responses model</span>
                    <select
                      value={selectedModel}
                      onChange={(event) => changeModel(event.target.value)}
                      disabled={isStarting || models.length === 0}
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.alias}>
                          {model.title || model.alias}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  <span>Language</span>
                  <select
                    value={languagePreference}
                    onChange={(event) =>
                      setLanguagePreference(
                        event.target.value as LanguagePreference,
                      )
                    }
                    disabled={
                      status === "thinking" ||
                      status === "speaking" ||
                      isStarting
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label>
                  <span>Voice</span>
                  <select
                    value={voice}
                    onChange={(event) =>
                      setVoice(
                        event.target.value as (typeof VOICE_OPTIONS)[number],
                      )
                    }
                    disabled={
                      status === "thinking" ||
                      status === "speaking" ||
                      isStarting
                    }
                  >
                    {VOICE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {accountError && <p className="settings-error">{accountError}</p>}
              <p className="text-[10px] leading-4 text-slate-500">
                Echo uses an AI-generated voice.
              </p>
            </div>
          </aside>
          {settingsOpen && (
            <button
              className="voice-settings-backdrop"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close voice settings"
            />
          )}
        </section>
      </div>
    </main>
  );
}
