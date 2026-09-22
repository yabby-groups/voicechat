export type MynaUser = {
  id?: number;
  uid?: number;
  name?: string;
  nick_name?: string;
  profile?: {
    avatar_url?: string;
    nick_name?: string;
  };
};

type OAuthServerMetadata = {
  device_authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
};

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

export type OAuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

type PendingDeviceAuthorization = {
  clientId: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
};

export type DeviceAuthorization = {
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
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

const AUTH_STORAGE_KEY = "echo-voicechat-myna-oauth-v1";
const LEGACY_AUTH_STORAGE_KEY = "echo-voicechat-myna-auth-v1";
const PENDING_DEVICE_AUTHORIZATION_STORAGE_KEY = "echo-voicechat-myna-device-auth-v1";
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

const viteEnv = (import.meta as ImportMeta & {
  env?: { VITE_MYNA_BASE_URL?: string; VITE_MYNA_OAUTH_CLIENT_ID?: string };
}).env;
export const mynaBaseUrl = (viteEnv?.VITE_MYNA_BASE_URL || defaultMynaBaseUrl()).replace(/\/+$/, "");
export const mynaOAuthClientId = viteEnv?.VITE_MYNA_OAUTH_CLIENT_ID?.trim() || "";
const OAUTH_SCOPES = "profile:read token_base:read token_base:write offline_access";

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
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${mynaBaseUrl}${path}`, { ...options, headers });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || (typeof body === "object" && body && ("err" in body || "error" in body))) {
    throw responseError(response, body);
  }
  return body as T;
}

export function getStoredAuthToken() {
  return getStoredOAuthSession()?.accessToken || "";
}

function getStoredOAuthSession(): OAuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Partial<OAuthSession>;
    if (
      typeof session.accessToken !== "string" ||
      typeof session.refreshToken !== "string" ||
      typeof session.expiresAt !== "number" ||
      typeof session.scope !== "string"
    )
      return null;
    return session as OAuthSession;
  } catch {
    return null;
  }
}

function storeOAuthSession(token: OAuthTokenResponse) {
  if (!token.refresh_token) throw new Error("Myna did not return a refresh token.");
  const session: OAuthSession = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope,
  };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
}

function responseMessage(response: Response, body: unknown) {
  if (typeof body === "object" && body && "error_description" in body && typeof body.error_description === "string") {
    return body.error_description;
  }
  return responseError(response, body).message;
}

async function oauthForm<T>(endpoint: string, body: URLSearchParams): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(responseMessage(response, result)) as Error & { code?: string };
    if (typeof result === "object" && result && "error" in result && typeof result.error === "string") {
      error.code = result.error;
    }
    throw error;
  }
  return result as T;
}

let oauthMetadataPromise: Promise<OAuthServerMetadata> | null = null;

async function oauthMetadata() {
  oauthMetadataPromise ||= fetch(`${mynaBaseUrl}/.well-known/oauth-authorization-server`, {
    headers: { Accept: "application/json" },
  }).then(async (response) => {
    const metadata: unknown = await response.json().catch(() => null);
    if (!response.ok || !metadata || typeof metadata !== "object") {
      throw new Error("Unable to discover Myna OAuth endpoints.");
    }
    const value = metadata as Partial<OAuthServerMetadata>;
    if (!value.device_authorization_endpoint || !value.token_endpoint) {
      throw new Error("Myna OAuth device authorization is unavailable.");
    }
    return value as OAuthServerMetadata;
  });
  try {
    return await oauthMetadataPromise;
  } catch (error) {
    oauthMetadataPromise = null;
    throw error;
  }
}

function requireOAuthClientId() {
  if (!mynaOAuthClientId) throw new Error("VoiceChat OAuth is not configured. Set VITE_MYNA_OAUTH_CLIENT_ID.");
  return mynaOAuthClientId;
}

function storePendingAuthorization(pending: PendingDeviceAuthorization) {
  sessionStorage.setItem(PENDING_DEVICE_AUTHORIZATION_STORAGE_KEY, JSON.stringify(pending));
}

function getPendingAuthorization(): PendingDeviceAuthorization | null {
  try {
    const raw = sessionStorage.getItem(PENDING_DEVICE_AUTHORIZATION_STORAGE_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as Partial<PendingDeviceAuthorization>;
    if (
      typeof pending.clientId !== "string" ||
      typeof pending.deviceCode !== "string" ||
      typeof pending.interval !== "number" ||
      typeof pending.expiresAt !== "number" ||
      pending.expiresAt <= Date.now()
    ) {
      sessionStorage.removeItem(PENDING_DEVICE_AUTHORIZATION_STORAGE_KEY);
      return null;
    }
    return pending as PendingDeviceAuthorization;
  } catch {
    sessionStorage.removeItem(PENDING_DEVICE_AUTHORIZATION_STORAGE_KEY);
    return null;
  }
}

function clearPendingAuthorization() {
  sessionStorage.removeItem(PENDING_DEVICE_AUTHORIZATION_STORAGE_KEY);
}

export async function beginDeviceAuthorization(completionAction?: "return") {
  const clientId = requireOAuthClientId();
  const metadata = await oauthMetadata();
  const body = new URLSearchParams({ client_id: clientId, scope: OAUTH_SCOPES });
  if (completionAction) body.set("completion_action", completionAction);
  const authorization = await oauthForm<{
    device_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval: number;
  }>(metadata.device_authorization_endpoint, body);
  storePendingAuthorization({
    clientId,
    deviceCode: authorization.device_code,
    interval: Math.max(1, authorization.interval || 3),
    expiresAt: Date.now() + authorization.expires_in * 1000,
  });
  return {
    verificationUri: authorization.verification_uri,
    verificationUriComplete: authorization.verification_uri_complete || authorization.verification_uri,
    expiresIn: authorization.expires_in,
  } satisfies DeviceAuthorization;
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

export async function resumeDeviceAuthorization() {
  const pending = getPendingAuthorization();
  if (!pending) return null;
  const metadata = await oauthMetadata();
  let interval = pending.interval;
  while (Date.now() < pending.expiresAt) {
    await wait(interval * 1000);
    try {
      const token = await oauthForm<OAuthTokenResponse>(metadata.token_endpoint, new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: pending.clientId,
        device_code: pending.deviceCode,
      }));
      const session = storeOAuthSession(token);
      clearPendingAuthorization();
      return session;
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        interval += 5;
        continue;
      }
      clearPendingAuthorization();
      throw error;
    }
  }
  clearPendingAuthorization();
  throw new Error("Authorization expired. Start again.");
}

export async function restoreOAuthSession() {
  const session = getStoredOAuthSession();
  if (!session) return null;
  if (session.expiresAt > Date.now() + 60_000) return session;
  const metadata = await oauthMetadata();
  try {
    return storeOAuthSession(await oauthForm<OAuthTokenResponse>(metadata.token_endpoint, new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requireOAuthClientId(),
      refresh_token: session.refreshToken,
    })));
  } catch (error) {
    clearAuthToken();
    throw error;
  }
}

export async function revokeOAuthSession() {
  const session = getStoredOAuthSession();
  clearAuthToken();
  if (!session) return;
  try {
    const metadata = await oauthMetadata();
    if (!metadata.revocation_endpoint) return;
    await oauthForm<unknown>(metadata.revocation_endpoint, new URLSearchParams({
      client_id: requireOAuthClientId(),
      token: session.refreshToken,
    }));
  } catch {
    // Local sign-out must not depend on network availability.
  }
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

export function getCurrentUser(authToken: string) {
  return request<{ user?: MynaUser }>("/api/user/me/", {}, authToken).then(
    (result): MynaUser => result.user || {},
  );
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
