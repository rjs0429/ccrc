import fs from "node:fs";
import path from "node:path";
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

export type UninstallCtx = Pick<Ctx, "at" | "run" | "ask" | "out" | "now"> & { o: UninstallOptions };

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
  if (typeof wrapper === "string" && inside(at.dataDir, wrapper)) {
    actions.push({
      title: `remove "${WRAPPER_SETTING}" from ${settings} (copied to ${path.join(at.stateDir, "backup")} first)`,
      vital: true,
      act: async () => {
        const r = changeSetting(settings, WRAPPER_SETTING, undefined, path.join(at.stateDir, "backup"), ctx.now());
        if (r.backup) ctx.out(`  the file as it was: ${r.backup}`);
      },
    });
  } else if (typeof wrapper === "string" && wrapper) notes.push(`VS Code's "${WRAPPER_SETTING}" is left: it points at ${wrapper}, not this install.`);

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
  } else if (unitText !== undefined) notes.push(`${SERVICE} is left: it runs ${program ?? "something else"}, not this install.`);

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
  if (fs.existsSync(at.dataDir)) actions.push({ title: `remove ${at.dataDir} (installed versions and Node)`, act: async () => fs.rmSync(at.dataDir, { recursive: true, force: true }) });
  if (o.purge) {
    for (const dir of [at.configDir, at.stateDir]) {
      if (fs.existsSync(dir)) actions.push({ title: `remove ${dir}`, act: async () => fs.rmSync(dir, { recursive: true, force: true }) });
    }
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
