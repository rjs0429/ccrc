import type { InstallInfo } from "./install.ts";
import type { Runner } from "./run.ts";

export const DEFAULT_REPO = "https://github.com/rjs0429/ccrc.git";

export type UpdateChannel = "stable" | "rc";
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "rc"];

const LS_REMOTE_TIMEOUT_MS = 30_000;

// A release tag (v1.2.3, v1.2.3-rc.4), or `git describe` past one (v1.2.3-5-gabcdef0) with `ahead` commits on it.
export interface Version {
  major: number;
  minor: number;
  patch: number;
  rc?: number;
  ahead?: number;
}

export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?(?:-(\d+)-g[0-9a-f]+)?(?:-dirty)?$/.exec(text.trim());
  if (!m) return undefined;
  const v: Version = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  if (m[4] !== undefined) v.rc = Number(m[4]);
  if (m[5] !== undefined) v.ahead = Number(m[5]);
  return v;
}

// Orders by SemVer, a release candidate before its release and commits past a tag after it.
export function compareVersions(a: Version, b: Version): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    (a.rc ?? Infinity) - (b.rc ?? Infinity) ||
    (a.ahead ?? 0) - (b.ahead ?? 0)
  );
}

// A tag a channel offers: a release tag, and on "rc" its release candidates too.
export function isReleaseTag(tag: string, channel: UpdateChannel = "stable"): boolean {
  const v = parseVersion(tag);
  return Boolean(v) && v!.ahead === undefined && /^v/.test(tag) && !tag.endsWith("-dirty") && (v!.rc === undefined || channel === "rc");
}

// The tag names in `git ls-remote --tags --refs` output.
export function parseLsRemote(out: string): string[] {
  const tags: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^[0-9a-f]{40,64}\trefs\/tags\/(.+)$/.exec(line.trim());
    if (m) tags.push(m[1]);
  }
  return tags;
}

export function latestTag(tags: string[], channel: UpdateChannel = "stable"): string | undefined {
  return tags
    .filter((t) => isReleaseTag(t, channel))
    .sort((a, b) => compareVersions(parseVersion(b)!, parseVersion(a)!))[0];
}

// Whether `tag` is a later version than `current`. A current version that is no release (a commit hash) is never
// behind, as nothing says where it stands.
export function isNewer(tag: string, current: string | undefined): boolean {
  const t = parseVersion(tag);
  const c = current ? parseVersion(current) : undefined;
  return Boolean(t && c) && compareVersions(t!, c!) > 0;
}

// Where updates come from: the repository the install looks for releases in (where it was fetched from, unless it
// names another), else updateRepo, else the project's own.
export function updateSource(info: Pick<InstallInfo, "source" | "updateSource"> | undefined, updateRepo: string | undefined): string {
  return info?.updateSource || info?.source || updateRepo || DEFAULT_REPO;
}

// The release page of a tag on GitHub, for a source that lives there.
export function releaseUrl(source: string, tag: string): string | undefined {
  const m = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(source);
  return m ? `https://github.com/${m[1]}/${m[2]}/releases/tag/${encodeURIComponent(tag)}` : undefined;
}

// Environment for git talking to a remote unattended: no password prompt, no credential helper popping up.
export function quietGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" };
}

// A user name or token written into a repository URL (https://user:token@host/...) is left out of messages, which
// reach the log and the phone's status page.
export function hideUserInfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
}

// What git's stderr says went wrong, most telling first. git often ends with advice ("Please make sure you have the
// correct access rights / and the repository exists."), so its last line is seldom the reason.
const GIT_REASONS = [
  /timed out/i,
  /not found|does not exist|does not appear to be a git repository|no such file or directory/i,
  /could not resolve|unable to access|connection (refused|reset)|network is unreachable|failed to connect|certificate|ssl/i,
  /could not read username|authentication failed|permission denied|terminal prompts disabled|host key verification failed/i,
];

// The one line of a failed git command's stderr worth showing.
export function gitReason(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const re of GIT_REASONS) {
    const hit = lines.find((l) => re.test(l));
    if (hit) return hit;
  }
  return lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines.at(-1);
}

export async function listTags(runner: Runner, source: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = LS_REMOTE_TIMEOUT_MS): Promise<string[]> {
  const r = await runner("git", ["-c", "credential.helper=", "ls-remote", "--tags", "--refs", source], { env: quietGitEnv(env), timeoutMs });
  // Hidden before it is cut short, so a cut cannot leave half of a user name or token where the pattern misses it.
  if (r.code !== 0) throw Error(hideUserInfo(`git ls-remote ${source} failed: ${hideUserInfo(gitReason(r.stderr) || `exit code ${r.code}`).slice(0, 300)}`));
  return parseLsRemote(r.stdout);
}

export interface ChangelogSection {
  version: string;
  text: string;
  // The lines under a "Breaking" heading, or lines that say BREAKING.
  breaking: string[];
}

// The sections of a Keep a Changelog file ("## [1.2.3] - date") for versions after `from` up to and including `to`;
// only `to`'s when `from` is no release.
export function changelogSections(changelog: string, to: string, from?: string): ChangelogSection[] {
  const target = parseVersion(to);
  if (!target) return [];
  const base = from ? parseVersion(from) : undefined;
  const sections: ChangelogSection[] = [];
  let current: { version: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const v = parseVersion(current.version)!;
    const inRange = base ? compareVersions(v, base) > 0 && compareVersions(v, target) <= 0 : compareVersions(v, target) === 0;
    if (inRange) sections.push({ version: current.version, text: current.lines.join("\n").trim(), breaking: breakingLines(current.lines) });
  };
  for (const line of changelog.split("\n")) {
    const heading = /^##\s+\[?(v?\d+\.\d+\.\d+(?:-rc\.\d+)?)\]?/.exec(line);
    if (heading || /^##\s/.test(line)) {
      flush();
      current = heading ? { version: heading[1], lines: [] } : undefined;
    } else current?.lines.push(line);
  }
  flush();
  return sections;
}

// An item wrapped onto indented lines is one line here.
function breakingLines(lines: string[]): string[] {
  const out: string[] = [];
  let under = false;
  let item = false;
  for (const line of lines) {
    if (/^###\s/.test(line)) {
      under = /breaking/i.test(line);
      item = false;
      continue;
    }
    if (!line.trim()) {
      item = false;
      continue;
    }
    if (item && /^\s+\S/.test(line) && !/^\s*[-*]\s/.test(line)) {
      out[out.length - 1] += ` ${line.trim()}`;
      continue;
    }
    item = (under || /\bBREAKING\b/.test(line)) && /^\s*[-*]\s/.test(line);
    if (under || /\bBREAKING\b/.test(line)) out.push(line.trim());
  }
  return out;
}
