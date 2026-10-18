import type { SearchResponse, Thread } from "../../broker/src/search-protocol.ts";
import type { BrokerSessionsInfo, ModelOption, PermissionModeName, SessionSummary, UploadInfo } from "../../broker/src/protocol.ts";

// passkey "due": the login holds until a passkey confirms it, and nothing else answers before that.
export interface Me {
  configured: boolean;
  loggedIn: boolean;
  device: string;
  passkey?: "due";
}

export interface PasskeyView {
  id: string;
  device: string;
  createdAt: number;
  lastUsedAt?: number;
  backedUp?: boolean;
  here: boolean;
  mine: boolean;
}

export interface PasskeyList {
  passkeys: PasskeyView[];
  hours: number;
  local: boolean;
  verifiedAt?: number;
}

type WebAuthnOptions = { options: Record<string, unknown> };

export interface Options {
  models: ModelOption[];
  modes: PermissionModeName[];
  folders: string[];
  // Missing from a broker older than the setting, which always started them.
  brokerSessions?: BrokerSessionsInfo;
}

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// A login a passkey has to confirm first answers 401 "passkey_required": the page asks for the passkey (onPasskeyDue)
// and the caller gets PASSKEY_DUE in place of 401, so it does not take the login for lost.
export const PASSKEY_DUE = 428;
let passkeyDue: (() => void) | undefined;

export function onPasskeyDue(fn: () => void): void {
  passkeyDue = fn;
}

function failure(status: number, body: Record<string, unknown>): ApiError {
  if (status !== 401 || body.error !== "passkey_required") return new ApiError(status, body);
  passkeyDue?.();
  return new ApiError(PASSKEY_DUE, body);
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw failure(res.status, data);
  return data as T;
}

// Sends a file as the raw body; XMLHttpRequest because fetch cannot report upload progress.
function upload(file: Blob, name: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<UploadInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as unknown as UploadInfo);
      else reject(failure(xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: "network" }));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  login: (id: string, password: string, takeover: boolean) => request<{ ok: true; passkey?: "due" }>("POST", "/api/login", { id, password, takeover }),
  logout: () => request<{ ok: true }>("POST", "/api/logout", {}),
  changePassword: (current: string, next: string) => request<{ ok: true }>("POST", "/api/password", { current, next }),
  sessions: () => request<SessionSummary[]>("GET", "/api/sessions"),
  options: () => request<Options>("GET", "/api/options"),
  search: (q: string) => request<SearchResponse>("POST", "/api/search", { q }),
  thread: (sessionId: string, itemId: string) => request<Thread>("POST", "/api/thread", { sessionId, itemId }),
  upload,
  passkeys: () => request<PasskeyList>("GET", "/api/passkeys"),
  passkeyRegisterOptions: (password: string) => request<WebAuthnOptions>("POST", "/api/passkeys/register/options", { password }),
  passkeyRegister: (credential: unknown) => request<{ passkey: PasskeyView }>("POST", "/api/passkeys/register", { credential }),
  passkeyVerifyOptions: () => request<{ options?: Record<string, unknown>; enroll?: true }>("POST", "/api/passkeys/verify/options", {}),
  passkeyVerify: (credential: unknown) => request<{ ok: true }>("POST", "/api/passkeys/verify", { credential }),
  passkeyRemove: (id: string, password: string) => request<{ ok: true }>("POST", "/api/passkeys/remove", { id, password }),
};
