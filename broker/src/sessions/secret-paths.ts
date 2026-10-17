import path from "node:path";
import { paths } from "../paths.ts";

export function inside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", ".gcloud", ".codex", ".terraform.d"]);
const SECRET_NAMES = new Set([
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".htpasswd",
  ".credentials.json",
  "credentials.json",
  ".boto",
  ".s3cfg",
  ".dockercfg",
  ".vault-token",
]);
const SECRET_PATTERNS = [
  /^\.claude\.json(\..*)?$/,
  /^\.env(\..*)?$/,
  /^\.envrc$/,
  /\.env$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/,
  /^ssh_host_.*_key$/,
  /^credentials(\.toml)?$/,
  /\.tfstate(\.backup)?$/,
  /\.tfvars(\.json)?$/,
];
const SECRET_SUBPATHS = [
  "/.config/gcloud/",
  "/.config/gh/hosts.yml",
  "/.config/hub/",
  "/.config/github-copilot/",
  "/.config/rclone/rclone.conf/",
  "/.cargo/credentials",
  "/.local/share/keyrings/",
];

// Files that hold keys or tokens, and ccrc's own state, are never shown, wherever they lie.
export function isSecretPath(p: string): boolean {
  const lower = path.resolve(p).toLowerCase();
  const segs = lower.split(path.sep).filter(Boolean);
  const name = segs[segs.length - 1] ?? "";
  if (segs.slice(0, -1).some((s) => SECRET_DIRS.has(s))) return true;
  if (SECRET_NAMES.has(name) || SECRET_PATTERNS.some((r) => r.test(name))) return true;
  if (SECRET_SUBPATHS.some((s) => `${lower}/`.includes(s))) return true;
  if (segs[0] === "proc") return true;
  // The user's Claude Code settings hold env values the settings screen hides.
  const claudeDirs = [path.join(paths.home, ".claude"), paths.claudeConfigDir].map((d) => d.toLowerCase());
  if (/^settings(\.local)?\.json$/.test(name) && claudeDirs.includes(path.dirname(lower))) return true;
  return [paths.configDir, paths.stateDir].some((d) => inside(path.resolve(p), d));
}
