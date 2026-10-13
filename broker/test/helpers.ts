import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-test-"));
}

export function tempStore(): Store {
  return new Store(path.join(tempDir(), "state.json"));
}
