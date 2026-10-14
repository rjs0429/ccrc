import type { SearchResponse } from "../../broker/src/search-protocol.ts";
import type { ModelOption, PermissionModeName, SessionSummary, UploadInfo } from "../../broker/src/protocol.ts";

export interface Me {
  configured: boolean;
  loggedIn: boolean;
  device: string;
}

export interface Options {
  models: ModelOption[];
  modes: PermissionModeName[];
  folders: string[];
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

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, data);
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
      else reject(new ApiError(xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: "network" }));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  login: (id: string, password: string, takeover: boolean) => request<{ ok: true }>("POST", "/api/login", { id, password, takeover }),
  logout: () => request<{ ok: true }>("POST", "/api/logout", {}),
  changePassword: (current: string, next: string) => request<{ ok: true }>("POST", "/api/password", { current, next }),
  sessions: () => request<SessionSummary[]>("GET", "/api/sessions"),
  options: () => request<Options>("GET", "/api/options"),
  search: (q: string) => request<SearchResponse>("POST", "/api/search", { q }),
  upload,
};
