import type { DialogInfo } from "./protocol.ts";

// The dialogs Claude Code asks a host to draw (request_user_dialog), as VS Code draws them. The usage credits consent
// is a billing choice for the account, so it is shown remotely but answered only where the session runs.
export const REFUSAL = "refusal_fallback_prompt";
export const AUTO_FALLBACK = "auto_mode_server_fallback";
export const CREDITS = "fable_overage_consent_prompt";

// The answers a remote user may give to each dialog it may answer, besides closing it ("cancel"), which Claude Code
// takes as the dialog's default.
export const DIALOG_CHOICES: Readonly<Record<string, readonly string[]>> = {
  [REFUSAL]: ["retry_fallback", "edit_prompt"],
  [AUTO_FALLBACK]: ["continue", "interrupt"],
};

// The kinds a session the broker runs declares it renders: Claude Code then asks before ending the turn on a refusal.
// Auto mode's billing notice stays undeclared, so Claude Code goes on in auto mode as it does with no one to ask;
// declared, a notice nobody answers before Claude Code's dialog deadline would stop the turn.
export const BROKER_DIALOGS = [REFUSAL];

export type DialogResult = { behavior: "completed"; result: string } | { behavior: "cancelled" };

const TEXT_MAX = 2000;
const NAME_MAX = 200;
const PARAGRAPHS_MAX = 10;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown, max = NAME_MAX): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);

export function answerable(kind: string): boolean {
  return Object.hasOwn(DIALOG_CHOICES, kind);
}

// What Claude Code is answered for a choice made on the phone; undefined for a choice the dialog does not offer.
export function dialogResult(kind: string, choice: unknown): DialogResult | undefined {
  if (!answerable(kind)) return undefined;
  if (choice === "cancel") return { behavior: "cancelled" };
  return typeof choice === "string" && DIALOG_CHOICES[kind].includes(choice) ? { behavior: "completed", result: choice } : undefined;
}

// A remote answer to a dialog, rebuilt from its known parts: closed, or completed with one of the dialog's choices.
export function dialogAnswer(kind: string, response: unknown): DialogResult | undefined {
  const r = obj(response);
  if (r.behavior === "cancelled" && Object.keys(r).length === 1) return dialogResult(kind, "cancel");
  if (r.behavior !== "completed" || Object.keys(r).length !== 2 || r.result === "cancel") return undefined;
  return dialogResult(kind, r.result);
}

// Help links open only on Claude's own sites, as VS Code allows.
function helpUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > TEXT_MAX) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && ["claude.com", "anthropic.com"].some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`)) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// The dialog's payload reduced to what the phone shows; undefined when the payload lacks what the dialog needs, which
// VS Code closes unanswered.
export function dialogInfo(kind: string, payload: unknown): DialogInfo | undefined {
  const p = obj(payload);
  if (kind === REFUSAL) {
    const model = text(p.originalModel);
    const fallback = text(p.fallbackModel);
    const category = text(p.apiRefusalCategory, 64);
    return model && fallback ? { kind, model, fallback, ...(category ? { category } : {}) } : undefined;
  }
  if (kind === AUTO_FALLBACK) {
    const title = text(p.title, TEXT_MAX);
    const paragraphs = (Array.isArray(p.paragraphs) ? p.paragraphs : []).map((x) => text(x, TEXT_MAX)).filter((x) => x !== undefined).slice(0, PARAGRAPHS_MAX);
    const help = helpUrl(p.helpUrl);
    const gateway = text(p.gatewayHost);
    return { kind, ...(title ? { title } : {}), paragraphs, ...(help ? { helpUrl: help } : {}), ...(gateway ? { gateway } : {}) };
  }
  if (kind === CREDITS) {
    if (typeof p.overagesEnabled !== "boolean") return undefined;
    const model = text(p.modelName, 60);
    const balance = typeof p.balanceCents === "number" && Number.isFinite(p.balanceCents) ? p.balanceCents : undefined;
    const currency = text(p.currency, 8);
    return { kind, enabled: p.overagesEnabled, ...(model ? { model } : {}), ...(balance !== undefined ? { balanceCents: balance } : {}), ...(currency ? { currency } : {}) };
  }
  return undefined;
}
