import fs from "node:fs";
import path from "node:path";
import { inServiceRefusal } from "../service-cgroup.ts";
import type { Ctx } from "./engine.ts";
import { SERVICE, unitFile, unitProgram } from "./service.ts";
import { brokerPort } from "./steps.ts";
import { reachesBroker, servedPorts } from "./tailscale.ts";
import { WRAPPER_SETTING, changeSetting, readSettingsFile, settingsFile } from "./vscode-settings.ts";

export interface UninstallOptions {
  purge: boolean;
  yes: boolean;
  dryRun: boolean;
  noSystem: boolean;
}

export type UninstallCtx = Pick<Ctx, "at" | "run" | "ask" | "out" | "now" | "inService"> & { o: UninstallOptions };

interface Action {
  title: string;
  // A failure stops the rest: VS Code must not be left pointing at a wrapper that is gone.
  vital?: boolean;
  act: () => Promise<void>;
}

function inside(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Folders other programs keep their files in, as CCRC_DATA_DIR, CCRC_CONFIG_DIR or CCRC_STATE_DIR set to a parent of
// ccrc's own folder would name them.
export function sharedFolders(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const bases = [".config", ".local", ".local/share", ".local/state", ".cache"].map((d) => path.join(home, d));
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) if (env[k] && path.isAbsolute(env[k])) bases.push(env[k]);
  return bases.map((d) => path.resolve(d));
}

// A folder ccrc may touch at all: not /, the home folder, a shared folder such as ~/.config, or a folder holding one.
export function safeToRemove(dir: string, home: string, shared = sharedFolders(home)): boolean {
  const d = path.resolve(dir);
  return path.isAbsolute(dir) && d !== path.parse(d).root && ![path.resolve(home), ...shared].some((p) => p === d || inside(d, p));
}

type Kind = "data" | "config" | "state";

// What ccrc keeps in each of its folders. A folder named "ccrc" that is empty or holds one of these goes whole;
// elsewhere only these entries go, and anything else in the folder stays.
const OWN: Record<Kind, { names: string[]; patterns: RegExp[] }> = {
  data: {
    names: ["versions", "current", "node", "history.json", "update.lock", "current.tmp", "node.tmp"],
    patterns: [/^node-v\d+\.\d+\.\d+-linux-[a-z0-9_]+$/, /^(current|history\.json)\.\d+\.tmp$/],
  },
  config: {
    names: ["config.json", "state.json", "push.json", "anthropic-api-key"],
    patterns: [/^(config\.json|state\.json|push\.json|anthropic-api-key)\.\d+\.tmp$/],
  },
  state: {
    names: [
      "audit.jsonl",
      "backup",
      "uploads",
      "turns",
      "cli",
      "doctor",
      "doctor.json",
      "commands.json",
      "remote-activity.json",
      "start-settings.json",
      "context-windows.json",
      "ultracode-models.json",
      "archived.json",
      "unread.json",
      "models.json",
      "update-check.json",
      "install.log",
      "wrapper.log",
      "wrapper.log.1",
      "link.sock",
    ],
    patterns: [/^[a-z-]+\.json\.\d+\.tmp$/],
  },
};

const NODE_ENTRY = (name: string) => name === "node" || name === "node.tmp" || /^node-v/.test(name);

function own(kind: Kind, name: string): boolean {
  return OWN[kind].names.includes(name) || OWN[kind].patterns.some((r) => r.test(name));
}

function entries(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function linkTarget(p: string): string | undefined {
  try {
    return path.resolve(path.dirname(p), fs.readlinkSync(p));
  } catch {
    return undefined;
  }
}

// Takes out what setup and install.sh put in place, VS Code's setting first: with the install gone, a VS Code still
// set to its wrapper cannot start Claude Code. Settings and state stay unless purge; Tailscale, Node and Claude Code stay.
export async function runUninstall(ctx: UninstallCtx): Promise<boolean> {
  const { at, o } = ctx;
  if (!o.dryRun && ctx.inService()) {
    ctx.out(inServiceRefusal("uninstall"));
    return false;
  }
  const actions: Action[] = [];
  const notes: string[] = [];
  const port = (() => {
    try {
      return brokerPort(ctx);
    } catch {
      return 8737;
    }
  })();

  const settings = settingsFile(at.vscodeUserDir);
  let wrapper: unknown;
  try {
    wrapper = readSettingsFile(settings)?.settings[WRAPPER_SETTING];
  } catch (e) {
    ctx.out(`${(e as Error).message}`);
    ctx.out(`Remove "${WRAPPER_SETTING}" from it by hand first, then run this again.`);
    return false;
  }
  // --purge removes the state folder, so the copy of VS Code's settings then stays next to them.
  const settingsBackup = o.purge ? path.dirname(settings) : path.join(at.stateDir, "backup");
  // A checkout of ccrc the service or VS Code still runs finds its Node through <dataDir>/node.
  let checkoutStays = false;
  if (typeof wrapper === "string" && inside(at.dataDir, wrapper)) {
    actions.push({
      title: `remove "${WRAPPER_SETTING}" from ${settings} (copied to ${settingsBackup} first)`,
      vital: true,
      act: async () => {
        const r = changeSetting(settings, WRAPPER_SETTING, undefined, settingsBackup, ctx.now());
        if (r.backup) ctx.out(`  the file as it was: ${r.backup}`);
      },
    });
  } else if (typeof wrapper === "string" && wrapper) {
    notes.push(`VS Code's "${WRAPPER_SETTING}" is left: it points at ${wrapper}, not this install.`);
    checkoutStays = true;
  }

  const unit = unitFile(at.xdgConfigHome);
  const unitText = fs.existsSync(unit) ? fs.readFileSync(unit, "utf8") : undefined;
  const program = unitText === undefined ? undefined : unitProgram(unitText);
  const ours = program !== undefined && inside(at.dataDir, program);
  if (ours && o.noSystem) notes.push(`${SERVICE} is left (--no-system).`);
  else if (ours) {
    actions.push({
      title: `stop and remove ${SERVICE} (${unit})`,
      act: async () => {
        await ctx.run.run("systemctl", ["--user", "disable", "--now", SERVICE]);
        fs.rmSync(unit, { force: true });
        await ctx.run.run("systemctl", ["--user", "daemon-reload"]);
      },
    });
  } else if (unitText !== undefined) {
    notes.push(`${SERVICE} is left: it runs ${program ?? "something else"}, not this install.`);
    checkoutStays = true;
  }

  if ((ours || unitText === undefined) && !o.noSystem && ctx.run.which("tailscale")) {
    for (const s of (await servedPorts(ctx.run)) ?? []) {
      if (!reachesBroker(s.proxy, port)) continue;
      actions.push({
        title: `tailscale serve --https=${s.httpsPort} off`,
        act: async () => {
          const r = await ctx.run.run("tailscale", ["serve", `--https=${s.httpsPort}`, "off"]);
          if (r.code !== 0) throw Error((r.stderr || r.stdout).trim() || `exit code ${r.code}`);
        },
      });
    }
  }

  const bin = path.join(at.home, ".local", "bin", "ccrc");
  const target = linkTarget(bin);
  if (target && inside(at.dataDir, target)) actions.push({ title: `remove the link ${bin}`, act: async () => fs.rmSync(bin, { force: true }) });
  const removeDir = (dir: string, kind: Kind, what: string, keep: (name: string) => boolean = () => false) => {
    if (!fs.existsSync(dir)) return;
    if (!safeToRemove(dir, at.home)) {
      notes.push(`${dir} is left: it is your home folder or a folder other programs share (check CCRC_DATA_DIR, CCRC_CONFIG_DIR and CCRC_STATE_DIR).`);
      return;
    }
    const names = entries(dir);
    const kept = names.filter(keep);
    const ours = names.filter((n) => own(kind, n) && !keep(n));
    if (!kept.length && path.basename(dir) === "ccrc" && (ours.length || !names.length)) {
      actions.push({ title: `remove ${dir} (${what})`, act: async () => fs.rmSync(dir, { recursive: true, force: true }) });
      return;
    }
    for (const n of ours) actions.push({ title: `remove ${path.join(dir, n)}`, act: async () => fs.rmSync(path.join(dir, n), { recursive: true, force: true }) });
    const others = names.filter((n) => !own(kind, n));
    if (others.length) notes.push(`${dir} keeps what ccrc did not make there: ${others.slice(0, 5).join(", ")}${others.length > 5 ? ", ..." : ""}.`);
  };
  const nodeKept = checkoutStays && entries(at.dataDir).some(NODE_ENTRY);
  if (nodeKept) notes.push(`${path.join(at.dataDir, "node")} is left: the ccrc that the service or VS Code still runs finds Node.js there.`);
  removeDir(at.dataDir, "data", "installed versions and Node", nodeKept ? NODE_ENTRY : undefined);
  if (o.purge) {
    removeDir(at.configDir, "config", "settings");
    removeDir(at.stateDir, "state", "state and logs");
  } else notes.push(`Settings and state stay in ${at.configDir} and ${at.stateDir} (--purge removes them).`);

  for (const n of notes) ctx.out(n);
  if (!actions.length) {
    ctx.out("Nothing of a ccrc install to remove.");
    return true;
  }
  ctx.out(o.dryRun ? "--dry-run: uninstall would, in this order:" : "Uninstall will, in this order:");
  for (const a of actions) ctx.out(`  - ${a.title}`);
  if (o.dryRun) return true;
  if (!o.yes && !(await ctx.ask.confirm("Go on?", false))) return false;

  let ok = true;
  for (const a of actions) {
    try {
      await a.act();
      ctx.out(`done: ${a.title}`);
    } catch (e) {
      ok = false;
      ctx.out(`failed: ${a.title}: ${(e as Error).message}`);
      if (a.vital) return false;
    }
  }
  ctx.out(ok ? "ccrc is removed. Tailscale, Node and Claude Code are left as they are." : "Some steps failed; see above.");
  return ok;
}
