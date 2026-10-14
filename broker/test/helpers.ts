import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { Store } from "../src/store.ts";

const made: string[] = [];
const removeMade = () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
};
// Exit catches files that timers still write after the last test.
after(removeMade);
process.once("exit", removeMade);

// Every folder made here is removed when the test file finishes.
export function tempDir(prefix = "ccrc-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function tempStore(): Store {
  return new Store(path.join(tempDir(), "state.json"));
}
