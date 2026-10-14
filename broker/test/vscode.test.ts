import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { continuesAfterReload, extensionHasMode, parseJsonc, permissionArgs, userDataDir, withoutOption } from "../src/wrapper/vscode.ts";
import { tempDir } from "./helpers.ts";

function dataDir(opts: { settings?: string; state?: Record<string, unknown>; sessionModes?: Record<string, string> } = {}): string {
  const dir = tempDir();
  const user = path.join(dir, "User");
  fs.mkdirSync(path.join(user, "globalStorage"), { recursive: true });
  if (opts.settings !== undefined) fs.writeFileSync(path.join(user, "settings.json"), opts.settings);
  if (opts.state) {
    const db = new DatabaseSync(path.join(user, "globalStorage", "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("Anthropic.claude-code", JSON.stringify(opts.state));
    db.close();
  }
  for (const [id, mode] of Object.entries(opts.sessionModes ?? {})) {
    const store = path.join(user, "globalStorage", "anthropic.claude-code", "session-permission-modes");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, `${id}.json`), JSON.stringify({ mode, updatedAt: Date.now() }));
  }
  return dir;
}

test("parseJsonc reads comments and trailing commas but leaves strings alone", () => {
  const text = `{
    // line comment
    "a": "http://x/*y*/", /* block */
    "b": [1, 2,],
    "c": "a,}",
  }`;
  assert.deepEqual(parseJsonc(text), { a: "http://x/*y*/", b: [1, 2], c: "a,}" });
});

test("userDataDir comes from VS Code's code cache folder", () => {
  assert.equal(userDataDir({ VSCODE_CODE_CACHE_PATH: "/home/u/.config/Code/CachedData/abc" }), "/home/u/.config/Code");
  assert.equal(userDataDir({ VSCODE_CODE_CACHE_PATH: "/somewhere/else" }), undefined);
  assert.equal(userDataDir({}), undefined);
});

test("extensionHasMode follows the extension's setting, session memory and last menu pick", async () => {
  assert.equal(await extensionHasMode(dataDir()), false);
  assert.equal(await extensionHasMode(dataDir({ settings: '{ "claudeCode.initialPermissionMode": "default", }' })), true);
  assert.equal(await extensionHasMode(dataDir({ state: { defaultPermissionMode: "default" } })), true);
  assert.equal(await extensionHasMode(dataDir({ state: { other: 1 } })), false);
  const remembered = dataDir({ sessionModes: { "s-1": "default" } });
  assert.equal(await extensionHasMode(remembered, "s-1"), true);
  assert.equal(await extensionHasMode(remembered, "s-2"), false);
  assert.equal(await extensionHasMode(remembered), false);
  assert.equal(await extensionHasMode(remembered, "../x"), undefined);
  assert.equal(await extensionHasMode(dataDir({ settings: "{ broken" })), undefined);
});

test("permissionArgs drops the default mode only when the extension had none", async () => {
  const none = dataDir();
  const picked = dataDir({ state: { defaultPermissionMode: "default" } });
  const base = ["--input-format", "stream-json"];
  assert.deepEqual(await permissionArgs([...base, "--permission-mode=default"], none), base);
  assert.deepEqual(await permissionArgs([...base, "--permission-mode", "default"], none), base);
  assert.deepEqual(await permissionArgs([...base, "--permission-mode=default"], picked), [...base, "--permission-mode=default"]);
  assert.deepEqual(await permissionArgs([...base, "--permission-mode=auto"], none), [...base, "--permission-mode=auto"]);
  assert.deepEqual(await permissionArgs([...base, "--permission-mode=default"], undefined), [...base, "--permission-mode=default"]);
  const args = [...base, "--resume=s-1", "--permission-mode=default"];
  assert.deepEqual(await permissionArgs(args, dataDir({ sessionModes: { "s-1": "default" } })), args);
  assert.deepEqual(await permissionArgs(args, none), [...base, "--resume=s-1"]);
});

test("withoutOption removes both spellings of an option", () => {
  assert.deepEqual(withoutOption(["a", "--x", "1", "b", "--x=2", "--xy=3"], "--x"), ["a", "b", "--xy=3"]);
});

test("continuesAfterReload is on unless the setting turns it off", () => {
  assert.equal(continuesAfterReload(undefined), true);
  assert.equal(continuesAfterReload(dataDir()), true);
  assert.equal(continuesAfterReload(dataDir({ settings: '{ "claudeCode.continueAfterReload": false }' })), false);
  assert.equal(continuesAfterReload(dataDir({ settings: "{ broken" })), true);
});
