import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Passkeys } from "../src/passkeys.ts";
import { Authenticator } from "./authenticator.ts";
import { tempDir } from "./helpers.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const ORIGIN = "https://laptop.example.ts.net";

function ccrc(dir: string, ...args: string[]) {
  const env = { ...process.env, HOME: dir, CCRC_CONFIG_DIR: path.join(dir, "config"), CCRC_STATE_DIR: path.join(dir, "state"), CCRC_DATA_DIR: path.join(dir, "data") };
  return spawnSync(process.execPath, [MAIN, "passkey", ...args], { env, encoding: "utf8", input: "" });
}

function withPasskeys(n: number): { dir: string; keys: Passkeys } {
  const dir = tempDir();
  const keys = new Passkeys(path.join(dir, "config", "passkeys.json"));
  const lease = { tokenHash: "aa", device: "phone", createdAt: 0, lastSeen: 0 };
  for (let i = 0; i < n; i++) {
    const a = new Authenticator();
    keys.register(lease, a.create(keys.registerOptions(lease, { origin: ORIGIN, rpId: "laptop.example.ts.net" }, "owner"), ORIGIN), "phone");
  }
  return { dir, keys };
}

test("ccrc passkey lists the passkeys, removes one by the start of its id, and resets them all", () => {
  const { dir, keys } = withPasskeys(2);
  const [first, second] = keys.list();
  const list = ccrc(dir, "list");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${first.id.slice(0, 12)}  phone for laptop.example.ts.net`));
  const removed = ccrc(dir, "remove", second.id.slice(0, 10));
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(
    keys.list().map((p) => p.id),
    [first.id],
  );
  assert.equal(ccrc(dir, "remove", "zzzz").status, 1);
  const asked = ccrc(dir, "reset");
  assert.equal(asked.status, 1, "without a terminal it asks for --yes");
  assert.match(asked.stderr, /--yes/);
  const reset = ccrc(dir, "reset", "--yes");
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /Removed 1 passkey\./);
  assert.deepEqual(keys.list(), []);
  assert.match(ccrc(dir).stdout, /No passkeys/);
  const audit = fs.readFileSync(path.join(dir, "state", "audit.jsonl"), "utf8");
  assert.match(audit, /"event":"passkey_removed"/);
  assert.match(audit, /"event":"passkey_reset"/);
  assert.equal(ccrc(dir, "add").status, 1);
});

test("ccrc passkey reset empties a file that cannot be read", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "passkeys.json"), "{ broken");
  assert.equal(ccrc(dir, "list").status, 1);
  const reset = ccrc(dir, "reset", "--yes");
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /could not be read/);
  assert.equal(ccrc(dir, "list").status, 0);
});
