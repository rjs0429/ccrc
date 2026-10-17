import type { DoctorResult } from "../admin-protocol.ts";
import { NoTerminalError, type Prompt, type Runner } from "./io.ts";

// `ccrc setup` is a list of steps. Each one checks whether its part is in place, and only when it is not does it
// say what it will do and do it, so running setup again does just what is still missing. A step that needs a person
// says what to do and checks again until it passes or the person skips it.

export interface SetupOptions {
  yes: boolean;
  dryRun: boolean;
  noSystem: boolean;
  noVscode: boolean;
  noServe: boolean;
  httpsPort: number;
  only?: string[];
  skip: string[];
}

// Where everything is, as setup found it.
export interface Where {
  home: string;
  user: string;
  configDir: string;
  configFile: string;
  credentialsFile: string;
  apiKeyFile: string;
  stateDir: string;
  dataDir: string;
  xdgConfigHome: string;
  codeRoot: string;
  installed: boolean;
  // bin/ccrc and bin/ccrc-wrapper as the service and VS Code run them: through <dataDir>/current for an install.
  ccrc: string;
  wrapper: string;
  vscodeUserDir: string;
  extensionsDir: string;
  platform: string;
  // ID from /etc/os-release.
  distro?: string;
  // The Node the service runs bin/ccrc with, and the PATH it gets.
  node: string;
  path: string;
  // Environment the service keeps, such as CCRC_CONFIG_DIR.
  keepEnv: Record<string, string>;
  version?: string;
}

export interface DoctorPort {
  last(): DoctorResult | undefined;
  extensionVersion(): string | undefined;
  run(): Promise<DoctorResult>;
}

export interface Ctx {
  o: SetupOptions;
  at: Where;
  run: Runner;
  ask: Prompt;
  out: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  // The version the broker on this port reports (null when it reports none), or undefined when nothing answers.
  ping: (port: number) => Promise<string | null | undefined>;
  doctor: DoctorPort;
  // How often a step that waits for a person checks again, and how long the service gets to answer.
  pollMs: number;
  pingWaitMs: number;
  now: () => Date;
}

export interface Check {
  ok: boolean;
  detail?: string;
}

export interface Step {
  id: string;
  title: string;
  // apply runs sudo: it is shown and asked before.
  sudo?: boolean;
  // It changes the system outside ccrc's own files; --no-system skips it, check and all.
  system?: boolean;
  // A person has a part in it; with waits, apply is followed by checking again until it passes.
  human?: boolean;
  waits?: boolean;
  // Asked before apply even when nothing needs sudo.
  confirm?: boolean;
  // Only shows the person what to do: a step left undone after it is "shown", not "left".
  informs?: boolean;
  // Steps that must not have failed or been left before this one runs.
  needs?: string[];
  // Why the step does not apply here, if it does not.
  skip?(ctx: Ctx): string | undefined;
  check(ctx: Ctx): Promise<Check>;
  // What apply would do, shown before it runs and by --dry-run.
  plan(ctx: Ctx): string[] | Promise<string[]>;
  apply(ctx: Ctx): Promise<void>;
}

export type Outcome = "ok" | "done" | "shown" | "skipped" | "todo" | "left" | "declined" | "blocked" | "failed";

export interface StepReport {
  id: string;
  title: string;
  outcome: Outcome;
  detail?: string;
}

export interface SetupResult {
  ok: boolean;
  reports: StepReport[];
}

const GOOD: Outcome[] = ["ok", "done", "shown", "skipped"];

export class SetupUsageError extends Error {}

function ids(list: string[] | undefined, steps: Step[], flag: string): Set<string> {
  const known = new Set(steps.map((s) => s.id));
  for (const id of list ?? []) if (!known.has(id)) throw new SetupUsageError(`${flag}: no step "${id}"; steps: ${[...known].join(", ")}`);
  return new Set(list);
}

function skipReason(step: Step, ctx: Ctx, only: Set<string> | undefined, skip: Set<string>): string | undefined {
  if (only && !only.has(step.id)) return "not in --only";
  if (skip.has(step.id)) return "--skip";
  if (step.system && ctx.o.noSystem) return "--no-system";
  return step.skip?.(ctx);
}

async function safeCheck(step: Step, ctx: Ctx): Promise<Check> {
  try {
    return await step.check(ctx);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

function line(ctx: Ctx, mark: string, step: Step, detail?: string): void {
  ctx.out(`  ${pad(`[${mark}]`, 7)}${pad(step.id, 20)}${step.title}${detail ? ` (${detail})` : ""}`);
}

// Checks again every pollMs until the step passes; Enter checks at once, "skip" leaves it for a later run.
async function waitFor(step: Step, ctx: Ctx): Promise<Check> {
  ctx.out(ctx.ask.interactive ? `Waiting for this; press Enter to check now, or type "skip" to leave it for later.` : "Waiting for this.");
  for (;;) {
    const typed = await ctx.ask.wait(ctx.pollMs);
    const c = await safeCheck(step, ctx);
    if (c.ok) return c;
    if (typed !== undefined && /^s(kip)?$/i.test(typed.trim())) return c;
  }
}

export async function runSetup(steps: Step[], ctx: Ctx): Promise<SetupResult> {
  const only = ctx.o.only ? ids(ctx.o.only, steps, "--only") : undefined;
  const skip = ids(ctx.o.skip, steps, "--skip");
  const reports = new Map<string, StepReport>();
  const report = (step: Step, outcome: Outcome, detail?: string) => reports.set(step.id, { id: step.id, title: step.title, outcome, ...(detail ? { detail } : {}) });
  const result = (ok: boolean): SetupResult => ({ ok, reports: steps.map((s) => reports.get(s.id)).filter((r): r is StepReport => Boolean(r)) });

  ctx.out("Checking what is in place:");
  const todo: Step[] = [];
  for (const step of steps) {
    const reason = skipReason(step, ctx, only, skip);
    if (reason === "not in --only") continue;
    if (reason) {
      line(ctx, "skip", step, reason);
      report(step, "skipped", reason);
      continue;
    }
    const c = await safeCheck(step, ctx);
    line(ctx, c.ok ? "ok" : "todo", step, c.detail);
    report(step, c.ok ? "ok" : "todo", c.detail);
    if (!c.ok) todo.push(step);
  }
  if (!todo.length) {
    ctx.out("Nothing to do.");
    return result(true);
  }

  if (ctx.o.dryRun) {
    ctx.out("");
    ctx.out("--dry-run: setup would do the following and change nothing now.");
    for (const step of todo) {
      ctx.out(`${step.id}: ${step.title}${step.sudo ? " (sudo)" : ""}${step.human ? " (needs you)" : ""}`);
      for (const p of await step.plan(ctx)) ctx.out(`  - ${p}`);
    }
    return result(true);
  }

  try {
    ctx.out("");
    if (!(await ctx.ask.confirm(`Go on with the ${todo.length} step${todo.length > 1 ? "s" : ""} marked todo?`, true))) {
      for (const step of todo) report(step, "declined");
      return result(true);
    }
    for (const step of todo) {
      const blocker = step.needs?.map((id) => reports.get(id)).find((r) => r && !GOOD.includes(r.outcome));
      ctx.out("");
      ctx.out(`== ${step.title} (${step.id})`);
      if (blocker) {
        ctx.out(`Left for later: it needs ${blocker.id}, which is ${blocker.outcome}.`);
        report(step, "blocked", `needs ${blocker.id}`);
        continue;
      }
      const before = await safeCheck(step, ctx);
      if (before.ok) {
        ctx.out(`Already in place${before.detail ? `: ${before.detail}` : ""}.`);
        report(step, "ok", before.detail);
        continue;
      }
      for (const p of await step.plan(ctx)) ctx.out(`  - ${p}`);
      if ((step.sudo || step.confirm) && !(await ctx.ask.confirm(step.sudo ? "Run this with sudo?" : "Do this?", true))) {
        report(step, "declined");
        continue;
      }
      try {
        await step.apply(ctx);
      } catch (e) {
        if (e instanceof NoTerminalError) throw e;
        const message = (e as Error).message;
        report(step, "failed", message);
        ctx.out("");
        ctx.out(`Step ${step.id} (${step.title}) failed: ${message}`);
        ctx.out(`Fix that and run \`ccrc setup\` again; steps already in place are passed over.`);
        return result(false);
      }
      let after = await safeCheck(step, ctx);
      if (!after.ok && step.waits) after = await waitFor(step, ctx);
      report(step, after.ok ? "done" : step.informs ? "shown" : "left", after.detail);
      if (after.ok) ctx.out(`Done${after.detail ? `: ${after.detail}` : ""}.`);
      else if (!step.informs) ctx.out(`Not finished${after.detail ? `: ${after.detail}` : ""}; run \`ccrc setup\` again to come back to it.`);
    }
  } catch (e) {
    if (!(e instanceof NoTerminalError)) throw e;
    ctx.out(e.message);
    return result(false);
  }

  const r = result(true);
  const open = r.reports.filter((x) => !GOOD.includes(x.outcome));
  ctx.out("");
  ctx.out(open.length ? `Still to do: ${open.map((x) => `${x.id} (${x.outcome})`).join(", ")}. Run \`ccrc setup\` again to finish.` : "Setup is complete.");
  return r;
}
