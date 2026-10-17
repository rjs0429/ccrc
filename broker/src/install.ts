import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.ts";

// An installed ccrc lives in <dataDir>/versions/<version>/, a git copy with its build, and <dataDir>/current is a relative
// link to one of them. Each version folder holds INSTALL_INFO, written by the installer.
export const INSTALL_INFO = ".ccrc-install.json";

export interface InstallInfo {
  version: string;
  commit: string;
  // Where it was fetched from: a repository URL or a local path.
  source: string;
  // The Node the installer found or fetched, which bin/ccrc and bin/ccrc-wrapper fall back on.
  node?: string;
  installedAt: string;
}

export type InstallKind = "installed" | "git" | "plain";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function real(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

export function installInfoFile(root = paths.codeRoot): string {
  return path.join(root, INSTALL_INFO);
}

// The install info of a code root, or undefined when it has none or one of another shape.
export function readInstallInfo(root = paths.codeRoot): InstallInfo | undefined {
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(installInfoFile(root), "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(v)) return undefined;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const version = str("version");
  if (!version) return undefined;
  const node = str("node");
  return { version, commit: str("commit") ?? "", source: str("source") ?? "", ...(node ? { node } : {}), installedAt: str("installedAt") ?? "" };
}

export function writeInstallInfo(root: string, info: InstallInfo): void {
  fs.writeFileSync(installInfoFile(root), JSON.stringify(info, null, 2) + "\n", { mode: 0o644 });
}

export function versionsDir(dataDir = paths.dataDir): string {
  return path.join(dataDir, "versions");
}

// Whether the code root is a version folder of the install under dataDir, with its install info.
export function isInstalled(root = paths.codeRoot, dataDir = paths.dataDir): boolean {
  const dir = real(root);
  const versions = real(versionsDir(dataDir));
  if (!dir || !versions || path.dirname(dir) !== versions) return false;
  return readInstallInfo(dir) !== undefined;
}

export function isGitCheckout(root = paths.codeRoot): boolean {
  return fs.existsSync(path.join(root, ".git"));
}

export function installKind(root = paths.codeRoot, dataDir = paths.dataDir): InstallKind {
  if (isInstalled(root, dataDir)) return "installed";
  return isGitCheckout(root) ? "git" : "plain";
}

export function packageVersion(root = paths.codeRoot): string | undefined {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return isObject(v) && typeof v.version === "string" ? v.version : undefined;
  } catch {
    return undefined;
  }
}

export interface VersionOptions {
  root?: string;
  dataDir?: string;
  git?: (root: string) => string | undefined;
}

function gitDescribe(root: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", root, "describe", "--always", "--dirty", "--match", "v[0-9]*"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

// The version an installed copy was installed as, else what git says of a checkout, else package.json's.
export function brokerVersion(o: VersionOptions = {}): string | undefined {
  const root = o.root ?? paths.codeRoot;
  const dataDir = o.dataDir ?? paths.dataDir;
  if (isInstalled(root, dataDir)) return readInstallInfo(root)?.version;
  if (isGitCheckout(root)) {
    const described = (o.git ?? gitDescribe)(root);
    if (described) return described;
  }
  return packageVersion(root);
}
