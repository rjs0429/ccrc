import type { ModelOption, PermissionModeName, SessionSummary } from "../../broker/src/protocol.ts";

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

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  login: (id: string, password: string, takeover: boolean) => request<{ ok: true }>("POST", "/api/login", { id, password, takeover }),
  logout: () => request<{ ok: true }>("POST", "/api/logout", {}),
  changePassword: (current: string, next: string) => request<{ ok: true }>("POST", "/api/password", { current, next }),
  sessions: () => request<SessionSummary[]>("GET", "/api/sessions"),
  options: () => request<Options>("GET", "/api/options"),
};
