export type MynaUser = {
  id?: number;
  uid?: number;
  name?: string;
  nick_name?: string;
};

export type TokenBaseToken = {
  id: number;
  token_name: string;
  token_key: string;
  status: number;
};

export type TokenBaseModel = {
  id: number;
  alias: string;
  name: string;
  title: string;
  enabled: number;
  api_modes?: string[] | string;
};

const AUTH_STORAGE_KEY = "echo-voicechat-myna-auth-v1";
const TOKEN_SELECTION_STORAGE_KEY = "echo-voicechat-token-id-v1";
const MODEL_SELECTION_STORAGE_KEY = "echo-voicechat-model-v1";
const AUDIO_RESPONSE_MODE_STORAGE_KEY = "echo-voicechat-audio-response-mode-v1";

function defaultMynaBaseUrl() {
  const hostname = window.location.hostname;
  if (hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return "https://huabot.com";
  }
  return `${window.location.protocol}//${window.location.host}`;
}

const viteEnv = (import.meta as ImportMeta & { env?: { VITE_MYNA_BASE_URL?: string } }).env;
export const mynaBaseUrl = (viteEnv?.VITE_MYNA_BASE_URL || defaultMynaBaseUrl()).replace(/\/+$/, "");

function responseError(response: Response, body: unknown) {
  if (typeof body === "object" && body && "err" in body && typeof body.err === "string") {
    return new Error(body.err);
  }
  if (typeof body === "object" && body && "error" in body && typeof body.error === "string") {
    return new Error(body.error);
  }
  if (typeof body === "object" && body && "err_msg" in body && typeof body.err_msg === "string") {
    return new Error(body.err_msg);
  }
  if (typeof body === "object" && body && "message" in body && typeof body.message === "string") {
    return new Error(body.message);
  }
  return new Error(response.status === 401 ? "Unauthorized" : `Myna request failed (${response.status}).`);
}

async function request<T>(path: string, options: RequestInit = {}, authToken?: string): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (authToken) headers.set("X-REQUEST-TOKEN", authToken);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${mynaBaseUrl}${path}`, { ...options, headers });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || (typeof body === "object" && body && ("err" in body || "error" in body))) {
    throw responseError(response, body);
  }
  return body as T;
}

export function getStoredAuthToken() {
  return localStorage.getItem(AUTH_STORAGE_KEY) || "";
}

export function storeAuthToken(token: string) {
  localStorage.setItem(AUTH_STORAGE_KEY, token);
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function getStoredTokenId() {
  return Number(localStorage.getItem(TOKEN_SELECTION_STORAGE_KEY) || 0);
}

export function storeTokenId(tokenId: number) {
  localStorage.setItem(TOKEN_SELECTION_STORAGE_KEY, String(tokenId));
}

export function getStoredModel() {
  return localStorage.getItem(MODEL_SELECTION_STORAGE_KEY) || "";
}

export function storeModel(model: string) {
  localStorage.setItem(MODEL_SELECTION_STORAGE_KEY, model);
}

export type AudioResponseMode = "direct" | "two_stage";

export function getStoredAudioResponseMode(): AudioResponseMode | "" {
  const mode = localStorage.getItem(AUDIO_RESPONSE_MODE_STORAGE_KEY);
  return mode === "direct" || mode === "two_stage" ? mode : "";
}

export function storeAudioResponseMode(mode: AudioResponseMode) {
  localStorage.setItem(AUDIO_RESPONSE_MODE_STORAGE_KEY, mode);
}

export function signIn(name: string, passwd: string, totpCode?: string) {
  const body = new URLSearchParams({ name, passwd });
  if (totpCode) body.set("totp_code", totpCode);
  return request<{ token: string; user: MynaUser }>("/api/signin/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
}

export function getCurrentUser(authToken: string) {
  return request<MynaUser>("/api/user/me/", {}, authToken);
}

export function listMyTokens(authToken: string) {
  return request<{ tokens: TokenBaseToken[] }>("/api/token_base/token/my/list/?status=1&size=50&offset=0", {}, authToken);
}

export function createVoicechatToken(authToken: string) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return request<{ token: TokenBaseToken }>("/api/token_base/token/create/", {
    method: "POST",
    body: JSON.stringify({ name: `voicechat-${stamp}` }),
  }, authToken);
}

export function listResponseModels() {
  return request<{ models: TokenBaseModel[] }>("/api/token_base/model/list/?enabled=1&size=500&offset=0");
}

export function supportsResponses(model: TokenBaseModel) {
  const modes = Array.isArray(model.api_modes)
    ? model.api_modes
    : typeof model.api_modes === "string"
      ? model.api_modes.split(",")
      : [];
  return modes.some((mode) => ["responses", "responses_api", "responses-api"].includes(mode.trim().toLowerCase()));
}

export function apiKeyFor(token: TokenBaseToken) {
  return token.token_key.startsWith("sk-") ? token.token_key : `sk-${token.token_key}`;
}
