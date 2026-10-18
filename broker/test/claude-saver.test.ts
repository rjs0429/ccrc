import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeSettingsView } from "../src/admin-protocol.ts";
import { SettingsSaver, type SaveResult, type SaverIo } from "../../web/src/screens/settings/claudeSaver.ts";

class Conflict extends Error {}

// A settings file behind the PUT and GET the screen uses: each write needs the hash of the file it was made against.
class FakeFile {
  values: Record<string, unknown>;
  hash = 1;
  writes: { changes: Record<string, unknown>; baseHash: string }[] = [];
  fail?: Error;
  problem?: "not_json";
  // Holds each write until release() is called, when set.
  gate?: Promise<void>;
  private open?: () => void;

  constructor(values: Record<string, unknown> = {}) {
    this.values = { ...values };
  }

  view(): ClaudeSettingsView {
    return { path: "/home/user/.claude/settings.json", exists: true, hash: String(this.hash), values: { ...this.values }, rest: {}, notes: [], ...(this.problem ? { problem: this.problem } : {}) };
  }

  hold(): void {
    this.gate = new Promise((r) => (this.open = r));
  }

  release(): void {
    this.open?.();
    this.gate = undefined;
  }

  // Someone else writes the file.
  edit(values: Record<string, unknown>): void {
    Object.assign(this.values, values);
    this.hash++;
  }

  io(): SaverIo {
    return {
      read: async () => this.view(),
      write: async (changes, baseHash) => {
        await this.gate;
        this.writes.push({ changes, baseHash });
        if (this.fail) throw this.fail;
        if (baseHash !== String(this.hash)) throw new Conflict("changed");
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) delete this.values[k];
          else this.values[k] = v;
        }
        this.hash++;
        return this.view();
      },
      conflict: (e) => e instanceof Conflict,
    };
  }
}

function setup(values: Record<string, unknown> = {}) {
  const file = new FakeFile(values);
  const results: SaveResult[] = [];
  const saver = new SettingsSaver(file.view(), file.io(), (r) => results.push(r));
  const settled = async () => {
    for (let i = 0; i < 50 && !saver.idle; i++) await new Promise((r) => setTimeout(r, 1));
    assert.ok(saver.idle, "the saver finished");
  };
  return { file, saver, results, settled };
}

test("writes keys one at a time in the order they changed, each against the last answer's hash", async () => {
  const { file, saver, results, settled } = setup({ theme: "dark" });
  saver.set("alwaysThinkingEnabled", false);
  saver.set("theme", "light");
  saver.set("language", "Korean");
  await settled();
  assert.deepEqual(
    file.writes.map((w) => [Object.keys(w.changes)[0], w.baseHash]),
    [
      ["alwaysThinkingEnabled", "1"],
      ["theme", "2"],
      ["language", "3"],
    ],
  );
  assert.deepEqual(file.values, { theme: "light", alwaysThinkingEnabled: false, language: "Korean" });
  assert.deepEqual(
    results.map((r) => r.t === "saved" && [r.key, r.before, r.after]),
    [
      ["alwaysThinkingEnabled", undefined, false],
      ["theme", "dark", "light"],
      ["language", undefined, "Korean"],
    ],
  );
});

test("a key changed again before its turn is written once with its latest value", async () => {
  const { file, saver, results, settled } = setup();
  file.hold();
  saver.set("theme", "light");
  saver.set("alwaysThinkingEnabled", true);
  saver.set("alwaysThinkingEnabled", false);
  saver.set("alwaysThinkingEnabled", undefined);
  saver.set("alwaysThinkingEnabled", true);
  assert.equal(saver.value("alwaysThinkingEnabled"), true, "the screen shows the latest value at once");
  assert.ok(saver.busy("alwaysThinkingEnabled") && saver.busy("theme"));
  file.release();
  await settled();
  assert.deepEqual(
    file.writes.map((w) => w.changes),
    [{ theme: "light" }, { alwaysThinkingEnabled: true }],
  );
  assert.equal(results.length, 2);
  assert.ok(!saver.busy("alwaysThinkingEnabled"));
});

test("a change the key already holds, an empty text and an empty list remove or skip as the file needs", async () => {
  const { file, saver, results, settled } = setup({ theme: "dark", language: "Korean", "permissions.allow": ["Bash(ls)"] });
  saver.set("theme", "dark");
  saver.set("language", "");
  saver.set("permissions.allow", []);
  await settled();
  assert.deepEqual(
    file.writes.map((w) => w.changes),
    [{ language: null }, { "permissions.allow": null }],
  );
  assert.deepEqual(file.values, { theme: "dark" });
  assert.equal(results.length, 2);
});

test("a write the file changed under goes again when the key there is still what the change was made from", async () => {
  const { file, saver, results, settled } = setup({ theme: "dark" });
  file.edit({ model: "sonnet" });
  saver.set("theme", "light");
  await settled();
  assert.deepEqual(
    file.writes.map((w) => w.baseHash),
    ["1", "2"],
  );
  assert.deepEqual(file.values, { theme: "light", model: "sonnet" });
  assert.equal(saver.view.values.model, "sonnet", "the other change shows too");
  assert.deepEqual(results, [{ t: "saved", key: "theme", before: "dark", after: "light", undo: false }]);
});

test("when the key itself changed in the file meanwhile, the file's value stands and is shown", async () => {
  const { file, saver, results, settled } = setup({ theme: "dark" });
  file.edit({ theme: "light-ansi" });
  saver.set("theme", "light");
  await settled();
  assert.equal(file.values.theme, "light-ansi");
  assert.equal(saver.value("theme"), "light-ansi");
  assert.deepEqual(results, [{ t: "changed", key: "theme" }]);
});

test("a file that keeps changing gives up after a few tries", async () => {
  const file = new FakeFile({ theme: "dark" });
  const io = file.io();
  const results: SaveResult[] = [];
  const restless: SaverIo = { ...io, write: (changes, baseHash) => (file.edit({ model: `m${file.hash}` }), io.write(changes, baseHash)) };
  const saver = new SettingsSaver(file.view(), restless, (r) => results.push(r));
  saver.set("theme", "light");
  for (let i = 0; i < 50 && !saver.idle; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(file.writes.length, 3);
  assert.equal(results[0].t, "failed");
  assert.equal(file.values.theme, "dark");
});

test("a failed write reads the file again, so the row shows what the file has", async () => {
  const { file, saver, results, settled } = setup({ theme: "dark" });
  file.fail = new Error("disk full");
  saver.set("theme", "light");
  await settled();
  assert.equal(saver.value("theme"), "dark");
  assert.equal(results[0].t, "failed");
  assert.equal((results[0] as { error: Error }).error.message, "disk full");

  file.fail = undefined;
  file.edit({ theme: "light-ansi" });
  saver.set("language", "Korean");
  await settled();
  assert.equal(saver.value("theme"), "light-ansi", "the file was read after the failure");
});

test("undo writes the value from before the change back through the same queue", async () => {
  const { file, saver, results, settled } = setup({ alwaysThinkingEnabled: true });
  saver.set("alwaysThinkingEnabled", false);
  await settled();
  const saved = results[0];
  assert.ok(saved.t === "saved");
  saver.set(saved.key, saved.before, true);
  await settled();
  assert.equal(file.values.alwaysThinkingEnabled, true);
  assert.deepEqual(results[1], { t: "saved", key: "alwaysThinkingEnabled", before: false, after: true, undo: true });

  saver.set("theme", "light");
  await settled();
  saver.set("theme", undefined, true);
  await settled();
  assert.equal("theme" in file.values, false, "undoing a key that was not there removes it");
});

test("nothing is written to a file that is not strict JSON", async () => {
  const { file, saver, results, settled } = setup({ theme: "dark" });
  file.problem = "not_json";
  await saver.reload();
  saver.set("theme", "light");
  await settled();
  assert.equal(file.writes.length, 0);
  assert.deepEqual(results, [{ t: "failed", key: "theme", error: "not_json" }]);
});

test("a read that a write overlapped is dropped; a read while idle shows the file", async () => {
  const { file, saver, settled } = setup({ theme: "dark" });
  const io = file.io();
  let late: (() => void) | undefined;
  const old = file.view();
  const slow = new SettingsSaver(old, { ...io, read: () => new Promise((r) => (late = () => r(old))) }, () => {});
  const reading = slow.reload();
  slow.set("theme", "light");
  for (let i = 0; i < 50 && !slow.idle; i++) await new Promise((r) => setTimeout(r, 1));
  late!();
  await reading;
  assert.equal(slow.value("theme"), "light", "the read began before the write and is dropped");

  file.edit({ theme: "auto" });
  await saver.reload();
  await settled();
  assert.equal(saver.value("theme"), "auto");
});
