import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isAbsoluteDir, isPermissionRule } from "../src/admin-protocol.ts";
import { ClaudeSettings, SettingsError } from "../src/claude-settings.ts";
import { tempDir } from "./helpers.ts";

const SAMPLE = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  model: "opus[1m]",
  env: { SECRET_TOKEN: "abc123" },
  permissions: { defaultMode: "auto", allow: ["Bash(npm test)"], disableBypassPermissionsMode: "disable" },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
  theme: "dark",
};

function setup(content: string | object = SAMPLE, mode = 0o640) {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  fs.chmodSync(file, mode);
  return { dir, file, settings: new ClaudeSettings(file) };
}

function refused(fn: () => unknown, status: number, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof SettingsError && e.status === status && e.message === code);
}

const backups = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith(".bak")).sort();

test("shows the editable keys, the rest of the file without environment values, and why the rest stays", () => {
  const { settings } = setup();
  const view = settings.read();
  assert.deepEqual(view.values, { model: "opus[1m]", "permissions.defaultMode": "auto", "permissions.allow": ["Bash(npm test)"], theme: "dark" });
  assert.deepEqual(Object.keys(view.rest), ["$schema", "env", "permissions", "hooks"]);
  assert.deepEqual(view.rest.permissions, { disableBypassPermissionsMode: "disable" });
  assert.doesNotMatch(JSON.stringify(view), /abc123/);
  assert.deepEqual(view.notes, [
    { key: "env", reason: "security" },
    { key: "hooks", reason: "command" },
    { key: "permissions.disableBypassPermissionsMode", reason: "security" },
  ]);
});

test("changes the allowed keys and keeps every other key, the key order, the layout and the mode", () => {
  const { file, settings } = setup();
  const { changed, view } = settings.update(
    { model: "sonnet", "permissions.allow": ["Bash(npm test)", "Read(./src/**)"], effortLevel: "high", theme: null },
    settings.read().hash,
  );
  assert.deepEqual(changed, ["model", "permissions.allow", "effortLevel", "theme"]);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw, JSON.stringify({ ...SAMPLE, model: "sonnet", permissions: { ...SAMPLE.permissions, allow: ["Bash(npm test)", "Read(./src/**)"] }, theme: undefined, effortLevel: "high" }, null, 2) + "\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(view.values.model, "sonnet");
  assert.notEqual(view.hash, settings.update({ model: "haiku" }, view.hash).view.hash);
});

test("keeps tab indentation and a missing final newline", () => {
  const { file, settings } = setup('{\n\t"model": "opus",\n\t"theme": "dark"\n}');
  settings.update({ model: "sonnet" }, settings.read().hash);
  assert.equal(fs.readFileSync(file, "utf8"), '{\n\t"model": "sonnet",\n\t"theme": "dark"\n}');
});

test("refuses keys that run commands or loosen security, leaving the file alone", () => {
  const { file, settings } = setup();
  const before = fs.readFileSync(file, "utf8");
  const { hash } = settings.read();
  const keys = [
    "hooks",
    "env",
    "apiKeyHelper",
    "statusLine",
    "otelHeadersHelper",
    "awsCredentialExport",
    "fileSuggestion",
    "sandbox",
    "enabledPlugins",
    "enableAllProjectMcpServers",
    "skipDangerousModePermissionPrompt",
    "remoteControlAtStartup",
    "permissions",
    "permissions.disableBypassPermissionsMode",
  ];
  for (const key of keys) refused(() => settings.update({ model: "haiku", [key]: true }, hash), 403, "not_allowed");
  refused(() => settings.update(JSON.parse('{"__proto__": {"model": "haiku"}}'), hash), 403, "not_allowed");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("never sets a permission mode that skips prompts", () => {
  const { file, settings } = setup();
  const before = fs.readFileSync(file, "utf8");
  const { hash } = settings.read();
  for (const mode of ["bypassPermissions", "dontAsk", "manual", "BypassPermissions"]) {
    refused(() => settings.update({ "permissions.defaultMode": mode }, hash), 400, "invalid");
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(settings.update({ "permissions.defaultMode": "plan" }, hash).changed, ["permissions.defaultMode"]);
});

test("a bypass mode already in the file is shown as a value that cannot be picked here", () => {
  const { settings } = setup({ permissions: { defaultMode: "bypassPermissions" } });
  assert.deepEqual(settings.read().notes, [{ key: "permissions.defaultMode", reason: "value" }]);
});

test("permission rules need the Tool or Tool(content) form and folders an absolute path", () => {
  for (const rule of ["Bash", "Bash(npm run test:*)", "Read(./.env)", "WebFetch(domain:example.com)", "Bash(echo (hi))", "mcp__github", "mcp__github__get_issue", "mcp__github__*"]) {
    assert.ok(isPermissionRule(rule), rule);
  }
  for (const rule of ["", "bash(ls)", "Bash()", "Bash(ls", "Bash ls", " Bash", "(x)", "mcp__github(x)", "Bash(a\nb)", `Bash(${"x".repeat(1000)})`]) {
    assert.ok(!isPermissionRule(rule), rule);
  }
  for (const dir of ["/", "/home/me/proj"]) assert.ok(isAbsoluteDir(dir), dir);
  for (const dir of ["", "rel/dir", "~/x", "/a/../b", "/a/./b", "/a/", "//a", "/a\u0000b"]) assert.ok(!isAbsoluteDir(dir), dir);

  const { settings } = setup({ permissions: { allow: ["bash(odd)"] } });
  const { hash } = settings.read();
  refused(() => settings.update({ "permissions.deny": ["Bash(rm -rf /)", "rm -rf"] }, hash), 400, "invalid");
  refused(() => settings.update({ "permissions.additionalDirectories": ["../outside"] }, hash), 400, "invalid");
  refused(() => settings.update({ "permissions.ask": "Bash" }, hash), 400, "invalid");
  refused(() => settings.update({ "permissions.allow": ["bash(new)"] }, hash), 400, "invalid");
  const { changed } = settings.update({ "permissions.allow": ["bash(odd)", "Bash(ls)", "Bash(ls)"], "permissions.additionalDirectories": ["/srv/data"] }, hash);
  assert.deepEqual(changed, ["permissions.allow", "permissions.additionalDirectories"]);
  assert.deepEqual(settings.read().values["permissions.allow"], ["bash(odd)", "Bash(ls)"]);
});

test("other values must fit their key", () => {
  const { settings } = setup();
  const { hash } = settings.read();
  const bad: Record<string, unknown> = {
    model: "opus model",
    language: "korean; rm",
    theme: "custom:mine",
    effortLevel: "max",
    alwaysThinkingEnabled: "true",
    respectGitignore: 1,
  };
  for (const [key, value] of Object.entries(bad)) refused(() => settings.update({ [key]: value }, hash), 400, "invalid");
  refused(() => settings.update({}, hash), 400, "invalid");
  refused(() => settings.update([], hash), 400, "invalid");
  refused(() => settings.update({ model: "sonnet" }, undefined), 400, "invalid");
});

test("answers 409 when the file changed after it was read", () => {
  const { file, settings } = setup();
  const { hash } = settings.read();
  fs.writeFileSync(file, JSON.stringify({ ...SAMPLE, model: "haiku" }, null, 2) + "\n");
  refused(() => settings.update({ model: "sonnet" }, hash), 409, "changed");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, "haiku");
  assert.deepEqual(backups(path.dirname(file)), []);
});

test("refuses to rewrite a file that is not strict JSON, so its comments stay", () => {
  for (const raw of ['{\n  // the model\n  "model": "opus"\n}\n', '{\n  "model": "opus",\n}\n', "[]\n"]) {
    const { file, settings } = setup(raw);
    const view = settings.read();
    assert.equal(view.problem, raw === "[]\n" ? "not_object" : "not_json");
    assert.deepEqual([view.values, view.rest], [{}, {}]);
    refused(() => settings.update({ model: "sonnet" }, view.hash), 422, view.problem!);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});

test("backs the file up before each change and keeps the last ten backups", () => {
  const { dir, file, settings } = setup();
  const t0 = Date.parse("2026-10-14T02:00:00.000Z");
  const contents: string[] = [];
  for (let i = 0; i < 12; i++) {
    contents.push(fs.readFileSync(file, "utf8"));
    settings.update({ model: i % 2 ? "opus" : "sonnet" }, settings.read().hash, t0 + i * 1000);
  }
  const names = backups(dir);
  assert.equal(names.length, 10);
  assert.equal(names[0], "settings.json.ccrc-20261014T020002000Z.bak");
  assert.equal(names[9], "settings.json.ccrc-20261014T020011000Z.bak");
  assert.equal(fs.readFileSync(path.join(dir, names[9]), "utf8"), contents[11]);
  assert.equal(fs.statSync(path.join(dir, names[9])).mode & 0o777, 0o600);

  settings.update({ model: "haiku" }, settings.read().hash, t0 + 11_000);
  assert.ok(backups(dir).includes("settings.json.ccrc-20261014T020011001Z.bak"), "a backup in the same millisecond gets the next one");
});

test("an unchanged value writes nothing", () => {
  const { dir, file, settings } = setup();
  const before = fs.statSync(file).mtimeMs;
  assert.deepEqual(settings.update({ theme: "dark", "permissions.allow": ["Bash(npm test)"] }, settings.read().hash).changed, []);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.deepEqual(backups(dir), []);
});

test("writes through a symlink and keeps it, with the backup beside the link", () => {
  const real = setup();
  const linkDir = tempDir();
  const link = path.join(linkDir, "settings.json");
  fs.symlinkSync(real.file, link);
  const settings = new ClaudeSettings(link);
  settings.update({ model: "sonnet" }, settings.read().hash);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(real.file, "utf8")).model, "sonnet");
  assert.equal(backups(linkDir).length, 1);
  assert.deepEqual(backups(real.dir), []);
});

test("creates a missing file, readable only by its owner", () => {
  const dir = path.join(tempDir(), ".claude");
  const settings = new ClaudeSettings(path.join(dir, "settings.json"));
  const view = settings.read();
  assert.equal(view.exists, false);
  settings.update({ "permissions.allow": ["Bash(git status)"] }, view.hash);
  assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }, null, 2) + "\n");
  assert.equal(fs.statSync(path.join(dir, "settings.json")).mode & 0o777, 0o600);
  settings.update({ "permissions.allow": null }, settings.read().hash);
  assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), "{}\n");
});
