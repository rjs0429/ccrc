import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import type { PendingRequest } from "../src/protocol.ts";
import { BrokerSession } from "../src/sessions/broker-session.ts";
import { tempDir } from "./helpers.ts";

// A session the broker runs, on the fake CLI: the dialogs it declares, and their answers.
const home = tempDir();
const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const sessions: BrokerSession[] = [];
after(async () => {
  for (const s of sessions) await s.close("test");
});

type Rec = { request?: Record<string, unknown>; dialogAnswer?: string; response?: unknown };
const files = new WeakMap<BrokerSession, string>();
const recorded = (s: BrokerSession): Rec[] =>
  fs.existsSync(files.get(s)!)
    ? fs
        .readFileSync(files.get(s)!, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Rec)
    : [];

async function until<T>(what: () => T | undefined, label: string): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const v = what();
    if (v !== undefined && v !== false) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error(`timed out waiting for ${label}`);
}

function started(): BrokerSession {
  const s = new BrokerSession(randomUUID(), cwd);
  sessions.push(s);
  files.set(s, path.join(home, `requests-${sessions.length}.jsonl`));
  s.start({ claudePath: FAKE, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_REQUESTS: files.get(s)! } });
  return s;
}

const nextPending = (s: BrokerSession) => new Promise<PendingRequest>((r) => s.once("pending_add", r));

test("a session the broker runs declares the refusal dialog and passes the answer on", async () => {
  const s = started();
  await s.started(30_000);
  const init = await until(() => recorded(s).find((r) => r.request?.subtype === "initialize"), "initialize");
  assert.deepEqual(init.request!.supportedDialogKinds, ["refusal_fallback_prompt"]);
  let asked = nextPending(s);
  s.send("DIALOG refusal_fallback_prompt");
  const refusal = await asked;
  assert.equal(refusal.kind, "dialog");
  assert.equal(refusal.localOnly, undefined);
  assert.deepEqual(refusal.dialog, { kind: "refusal_fallback_prompt", model: "claude-opus-5-5", fallback: "claude-sonnet-5", category: "cyber" });
  await assert.rejects(s.answer(refusal.id, { kind: "dialog", choice: "continue" }), /invalid answer/);
  await s.answer(refusal.id, { kind: "dialog", choice: "retry_fallback" });
  assert.equal(s.pending.size, 0);
  const got = await until(() => recorded(s).find((r) => r.dialogAnswer === refusal.id), "the answer");
  assert.deepEqual(got.response, { behavior: "completed", result: "retry_fallback" });

  asked = nextPending(s);
  s.send("DIALOG refusal_fallback_prompt");
  const again = await asked;
  await s.answer(again.id, { kind: "dialog", choice: "cancel" });
  const closed = await until(() => recorded(s).find((r) => r.dialogAnswer === again.id), "the close");
  assert.deepEqual(closed.response, { behavior: "cancelled" });
});

test("a dialog it cannot show or did not declare is closed at once, auto mode's notice among them", async () => {
  const s = new BrokerSession(randomUUID(), cwd);
  const ask = (s as unknown as { onUserDialog: (r: unknown, o: unknown) => Promise<unknown> }).onUserDialog;
  const ac = new AbortController();
  assert.deepEqual(await ask({ dialogKind: "refusal_fallback_prompt", payload: { originalModel: "a" } }, { signal: ac.signal, requestId: "x1" }), { behavior: "cancelled" });
  assert.deepEqual(await ask({ dialogKind: "fable_overage_consent_prompt", payload: { overagesEnabled: true } }, { signal: ac.signal, requestId: "x2" }), { behavior: "cancelled" });
  assert.deepEqual(await ask({ dialogKind: "auto_mode_server_fallback", payload: { title: "t", paragraphs: [] } }, { signal: ac.signal, requestId: "x3" }), { behavior: "cancelled" });
  assert.equal(s.pending.size, 0);
});

test("a dialog Claude Code cancels (its deadline) leaves the phone, and closing the session closes its dialogs", async () => {
  const s = new BrokerSession(randomUUID(), cwd);
  const ask = (s as unknown as { onUserDialog: (r: unknown, o: unknown) => Promise<unknown> }).onUserDialog;
  const refusal = { dialogKind: "refusal_fallback_prompt", payload: { originalModel: "claude-opus-5-5", fallbackModel: "claude-sonnet-5" } };
  const ac = new AbortController();
  const first = ask(refusal, { signal: ac.signal, requestId: "y1" });
  assert.equal(s.pending.size, 1);
  const gone = new Promise((r) => s.once("pending_remove", r));
  ac.abort();
  assert.equal(await gone, "y1");
  assert.deepEqual(await first, { behavior: "cancelled" });
  assert.equal(s.pending.size, 0);
  const second = ask(refusal, { signal: new AbortController().signal, requestId: "y2" });
  await s.close("test");
  assert.deepEqual(await second, { behavior: "cancelled" });
});

test("an MCP sign-in of a session the broker runs asks Claude Code by the server name, hands back the redirect and connects the server again", async () => {
  const s = new BrokerSession(randomUUID(), cwd);
  const asked: unknown[] = [];
  (s as unknown as { q: object }).q = {
    mcpServerStatus: async () => [{ name: "linear", status: "needs-auth", config: { type: "sse", url: "https://mcp.example.com" } }],
    reconnectMcpServer: async (name: string) => void asked.push({ reconnect: name }),
    request: async (r: Record<string, unknown>) => {
      asked.push(r);
      return { response: r.subtype === "mcp_authenticate" ? { authUrl: "https://auth.example.com/a", requiresUserAction: true, callbackExpected: true, state: "s" } : {} };
    },
  };
  assert.deepEqual(await s.mcpAuthenticate("linear"), { url: "https://auth.example.com/a", callback: true });
  const url = "http://127.0.0.1:43123/callback?code=c&state=s";
  assert.deepEqual(await s.mcpOAuthCallback("linear", url), [{ name: "linear", status: "needs-auth", auth: "oauth" }]);
  await assert.rejects(s.mcpOAuthCallback("linear", "http://example.com/callback?code=c"), /invalid callback URL/);
  await assert.rejects(s.mcpAuthenticate("gitlab"), /unknown MCP server/);
  assert.deepEqual(asked, [
    { subtype: "mcp_authenticate", serverName: "linear" },
    { subtype: "mcp_oauth_callback_url", serverName: "linear", callbackUrl: url },
    { reconnect: "linear" },
  ]);
});
