import fs from "node:fs";
import { writeFileAtomic } from "../config.ts";
import { MODEL_NAME } from "./start-store.ts";

const KEEP_MODELS = 50;

const base = (model: string) => model.replace(/\[1m\]$/i, "");

// Whether Claude Code offered Ultracode with a model, as sessions last reported it in get_settings, kept across
// broker runs so a new session can show the switch before it starts. A 1M variant counts as its model.
export class UltracodeModels {
  private file: string;
  private loaded?: Map<string, boolean>;

  constructor(file: string) {
    this.file = file;
  }

  get(model: string | undefined): boolean | undefined {
    return model ? this.load().get(base(model)) : undefined;
  }

  learn(model: string, available: boolean): void {
    if (!MODEL_NAME.test(model)) return;
    const m = this.load();
    const key = base(model);
    if (m.get(key) === available && [...m.keys()].at(-1) === key) return;
    m.delete(key);
    m.set(key, available);
    for (const old of [...m.keys()].slice(0, -KEEP_MODELS)) m.delete(old);
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(m)) + "\n");
    } catch {}
  }

  private load(): Map<string, boolean> {
    if (this.loaded) return this.loaded;
    this.loaded = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [model, v] of Object.entries(saved)) if (MODEL_NAME.test(model) && typeof v === "boolean") this.loaded.set(model, v);
      }
    } catch {}
    return this.loaded;
  }
}
