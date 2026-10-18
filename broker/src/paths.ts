import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every folder ccrc reads or writes outside its own code, found in one place. Each is read from the environment when
// asked for, so a test that sets the environment before it starts gets folders of its own.

const env = () => process.env;
const home = (): string => os.homedir();
const xdg = (name: string, fallback: string[]): string => env()[name] || path.join(home(), ...fallback);

// The code root: the git checkout or installed version folder holding bin/, broker/ and web/. The file sits in
// broker/src, or broker/dist once built, so the root is two folders up either way.
const codeRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

export const paths = {
  get home(): string {
    return home();
  },
  get xdgConfigHome(): string {
    return xdg("XDG_CONFIG_HOME", [".config"]);
  },
  get xdgStateHome(): string {
    return xdg("XDG_STATE_HOME", [".local", "state"]);
  },
  get xdgDataHome(): string {
    return xdg("XDG_DATA_HOME", [".local", "share"]);
  },
  // The user's runtime folder, when the session has one.
  get runtimeDir(): string | undefined {
    return env().XDG_RUNTIME_DIR || undefined;
  },
  get configDir(): string {
    return env().CCRC_CONFIG_DIR || path.join(this.xdgConfigHome, "ccrc");
  },
  get stateDir(): string {
    return env().CCRC_STATE_DIR || path.join(this.xdgStateHome, "ccrc");
  },
  // Installed versions, the `current` link and the Node an installer fetched.
  get dataDir(): string {
    return env().CCRC_DATA_DIR || path.join(this.xdgDataHome, "ccrc");
  },
  // Claude Code's own folder: settings, transcripts (projects/), running sessions (sessions/), file checkpoints.
  get claudeConfigDir(): string {
    return env().CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
  },
  get claudeProjectsDir(): string {
    return path.join(this.claudeConfigDir, "projects");
  },
  get claudeSessionsDir(): string {
    return path.join(this.claudeConfigDir, "sessions");
  },
  // VS Code's user data folder (User/settings.json and globalStorage live in it).
  get vscodeUserDir(): string {
    return path.join(this.xdgConfigHome, "Code");
  },
  get vscodeExtensionsDir(): string {
    return env().CCRC_VSCODE_EXTENSIONS_DIR || path.join(home(), ".vscode", "extensions");
  },
  get configFile(): string {
    return path.join(this.configDir, "config.json");
  },
  get credentialsFile(): string {
    return path.join(this.configDir, "state.json");
  },
  // The phones' passkeys, which confirm a remote login (passkeys.ts).
  get passkeysFile(): string {
    return path.join(this.configDir, "passkeys.json");
  },
  // The Anthropic API key broker sessions sign in with when brokerSessions is "apiKey".
  get apiKeyFile(): string {
    return path.join(this.configDir, "anthropic-api-key");
  },
  get auditFile(): string {
    return path.join(this.stateDir, "audit.jsonl");
  },
  codeRoot,
  webDir: path.join(codeRoot, "web", "dist") + "/",
};
