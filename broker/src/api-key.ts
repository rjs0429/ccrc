import fs from "node:fs";
import { writeFileAtomic } from "./config.ts";
import { paths } from "./paths.ts";

// The Anthropic API key broker sessions sign in with when brokerSessions is "apiKey": one line in a file only the
// user can read. It goes nowhere but the environment of the Claude Code processes the broker starts.

export function readApiKey(file = paths.apiKeyFile): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function writeApiKey(key: string, file = paths.apiKeyFile): void {
  const value = key.trim();
  if (!value || /\s/.test(value)) throw Error("the API key must be one word without spaces");
  writeFileAtomic(file, value + "\n");
  fs.chmodSync(file, 0o600);
}
