import fs from "node:fs";
import path from "node:path";
import { applyMigrations, checkConfig, ensureDir, parseConfigText, writeConfig } from "./config.ts";
import { paths } from "./paths.ts";

export interface MigrateResult {
  from: number;
  to: number;
  // Where the files were copied before they changed; none when nothing changed.
  backupDir?: string;
}

export interface MigrateOptions {
  configFile?: string;
  stateDir?: string;
  now?: Date;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Brings config.json to the format this ccrc writes. The file as it was is copied first to
// <stateDir>/backup/migrate-<from>-<to>-<time>/; a missing file is left for the broker to make.
export function migrateConfigFile(o: MigrateOptions = {}): MigrateResult | undefined {
  const file = o.configFile ?? paths.configFile;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const raw = parseConfigText(text, file);
  const { config, from } = applyMigrations(raw, file);
  checkConfig(config, file);
  const to = config.schemaVersion as number;
  if (from === to && raw.schemaVersion === to) return { from, to };
  const backupDir = path.join(o.stateDir ?? paths.stateDir, "backup", `migrate-${from}-${to}-${stamp(o.now ?? new Date())}`);
  ensureDir(backupDir);
  fs.writeFileSync(path.join(backupDir, path.basename(file)), text, { mode: 0o600, flag: "wx" });
  writeConfig(config, file);
  return { from, to, backupDir };
}
