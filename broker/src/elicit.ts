// MCP elicitation: the form an MCP server asks to have filled, reduced to the fields the phone draws, and the
// checks an answer passes before it goes back to Claude Code. Shared by the broker and the web client.
import type { ElicitField, ElicitFormat, ElicitInfo, ElicitOption, ElicitValue } from "./protocol.ts";

type Obj = Record<string, unknown>;

const NAME_MAX = 200;
const MESSAGE_MAX = 4000;
const TEXT_MAX = 1000;
const URL_MAX = 4096;
const FIELDS_MAX = 50;
const OPTIONS_MAX = 200;
const VALUE_MAX = 1000;
// A string field without its own maxLength.
const STRING_MAX = 10_000;
const FORMATS = new Set<unknown>(["email", "uri", "date", "date-time"]);

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number | undefined => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
const len = (s: string): number => [...s].length;

// The request as the Agent SDK hands it over (ElicitationRequest).
export interface ElicitRequest {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}

// Option values travel back verbatim, so a list whose values cannot be shown whole is not offered.
function options(list: unknown, titles?: unknown): ElicitOption[] | undefined {
  if (!Array.isArray(list) || !list.length || list.length > OPTIONS_MAX) return undefined;
  const out: ElicitOption[] = [];
  for (const [i, o] of list.entries()) {
    const value = isObj(o) ? o.const : o;
    if (typeof value !== "string" || value.length > VALUE_MAX) return undefined;
    const title = isObj(o) ? o.title : Array.isArray(titles) ? titles[i] : undefined;
    out.push({ value, title: text(title, TEXT_MAX) ?? value });
  }
  return out;
}

function field(key: string, p: unknown, required: boolean): ElicitField | undefined {
  if (!isObj(p)) return undefined;
  const base = {
    key,
    ...(text(p.title, NAME_MAX) ? { title: text(p.title, NAME_MAX) } : {}),
    ...(text(p.description, TEXT_MAX) ? { description: text(p.description, TEXT_MAX) } : {}),
    required,
  };
  if (p.type === "string") {
    const choices = p.enum !== undefined ? options(p.enum, p.enumNames) : p.oneOf !== undefined ? options(p.oneOf) : null;
    if (choices === undefined) return undefined;
    if (choices) {
      const d = typeof p.default === "string" && choices.some((o) => o.value === p.default) ? p.default : undefined;
      return { ...base, type: "choice", options: choices, ...(d !== undefined ? { default: d } : {}) };
    }
    if (p.format !== undefined && !FORMATS.has(p.format)) return undefined;
    const minLength = count(p.minLength);
    const maxLength = count(p.maxLength);
    return {
      ...base,
      type: "string",
      ...(p.format ? { format: p.format as ElicitFormat } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(typeof p.default === "string" && p.default.length <= STRING_MAX ? { default: p.default } : {}),
    };
  }
  if (p.type === "number" || p.type === "integer") {
    const minimum = num(p.minimum);
    const maximum = num(p.maximum);
    const d = num(p.default);
    return {
      ...base,
      type: p.type,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(d !== undefined ? { default: d } : {}),
    };
  }
  if (p.type === "boolean") return { ...base, type: "boolean", ...(typeof p.default === "boolean" ? { default: p.default } : {}) };
  if (p.type === "array" && isObj(p.items)) {
    const choices = p.items.enum !== undefined ? options(p.items.enum) : options(p.items.anyOf);
    if (!choices) return undefined;
    const minItems = count(p.minItems);
    const maxItems = count(p.maxItems);
    const d = Array.isArray(p.default) && p.default.every((v) => choices.some((o) => o.value === v)) ? (p.default as string[]) : undefined;
    return {
      ...base,
      type: "multi",
      options: choices,
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(d ? { default: d } : {}),
    };
  }
  return undefined;
}

// The form fields of a requested schema; unsupported when any field is of a kind the phone cannot fill.
export function elicitFields(schema: unknown): { fields: ElicitField[]; unsupported?: boolean } {
  if (schema === undefined) return { fields: [] };
  if (!isObj(schema) || (schema.properties !== undefined && !isObj(schema.properties))) return { fields: [], unsupported: true };
  const props = Object.entries((schema.properties as Obj | undefined) ?? {});
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);
  if (props.length > FIELDS_MAX || [...required].some((k) => !props.some(([key]) => key === k))) return { fields: [], unsupported: true };
  const fields: ElicitField[] = [];
  for (const [key, p] of props) {
    const f = key.length <= NAME_MAX ? field(key, p, required.has(key)) : undefined;
    if (!f) return { fields: [], unsupported: true };
    fields.push(f);
  }
  return { fields };
}

export function elicitInfo(r: ElicitRequest): ElicitInfo {
  const title = text(r.title, NAME_MAX) ?? text(r.displayName, NAME_MAX);
  const description = text(r.description, TEXT_MAX);
  const head = {
    server: text(r.serverName, NAME_MAX) ?? "",
    message: text(r.message, MESSAGE_MAX) ?? "",
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
  if (r.mode === "url") {
    const url = typeof r.url === "string" && r.url.length <= URL_MAX ? r.url : undefined;
    return { ...head, mode: "url", ...(url ? { url } : { unsupported: true }) };
  }
  const { fields, unsupported } = elicitFields(r.requestedSchema);
  return { ...head, mode: "form", fields, ...(unsupported ? { unsupported } : {}) };
}

export type FieldProblem = "required" | "type" | "short" | "long" | "format" | "small" | "large" | "choice" | "few" | "many";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/i;

function validDate(y: string, m: string, d: string): boolean {
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return t.getUTCFullYear() === Number(y) && t.getUTCMonth() === Number(m) - 1 && t.getUTCDate() === Number(d);
}

function formatOk(format: ElicitFormat, s: string): boolean {
  if (format === "email") return EMAIL.test(s);
  if (format === "uri") {
    if (!/^[a-z][a-z0-9+.-]*:\S+$/i.test(s)) return false;
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  }
  const m = (format === "date" ? DATE : DATE_TIME).exec(s);
  return Boolean(m && validDate(m[1], m[2], m[3]));
}

// What is wrong with one value, or undefined when it may be sent; a missing value is `undefined`.
export function fieldProblem(f: ElicitField, v: unknown): FieldProblem | undefined {
  if (v === undefined || (f.type === "string" && v === "")) return f.required ? "required" : undefined;
  switch (f.type) {
    case "string":
      if (typeof v !== "string") return "type";
      if (f.minLength !== undefined && len(v) < f.minLength) return "short";
      if (len(v) > (f.maxLength ?? STRING_MAX)) return "long";
      if (f.format && !formatOk(f.format, v)) return "format";
      return undefined;
    case "number":
    case "integer":
      if (typeof v !== "number" || !Number.isFinite(v) || (f.type === "integer" && !Number.isInteger(v))) return "type";
      if (f.minimum !== undefined && v < f.minimum) return "small";
      if (f.maximum !== undefined && v > f.maximum) return "large";
      return undefined;
    case "boolean":
      return typeof v === "boolean" ? undefined : "type";
    case "choice":
      if (typeof v !== "string") return "type";
      return f.options.some((o) => o.value === v) ? undefined : "choice";
    case "multi": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return "type";
      if (new Set(v).size !== v.length || v.some((x) => !f.options.some((o) => o.value === x))) return "choice";
      if (f.minItems !== undefined && v.length < f.minItems) return "few";
      if (f.maxItems !== undefined && v.length > f.maxItems) return "many";
      return undefined;
    }
  }
}

// The content to send for a filled form: only the form's fields, each checked against its schema.
export function elicitContent(info: ElicitInfo, content: unknown): Record<string, ElicitValue> {
  if (info.mode !== "form" || info.unsupported || !info.fields) throw Error("this request cannot be filled in here");
  if (!isObj(content)) throw Error("invalid answer");
  const fields = info.fields;
  for (const k of Object.keys(content)) if (!fields.some((f) => f.key === k)) throw Error(`invalid answer: unknown field ${k}`);
  const out: [string, ElicitValue][] = [];
  for (const f of fields) {
    const v = Object.hasOwn(content, f.key) ? content[f.key] : undefined;
    const problem = fieldProblem(f, v);
    if (problem) throw Error(`invalid answer: ${f.key} ${problem}`);
    if (v !== undefined && v !== "") out.push([f.key, Array.isArray(v) ? [...v] : (v as ElicitValue)]);
  }
  return Object.fromEntries(out);
}

// The result for Claude Code: content only with a filled form's accept; a page is accepted once the user is done.
export function elicitResult(info: ElicitInfo, action: unknown, content: unknown): { action: "accept" | "decline" | "cancel"; content?: Record<string, ElicitValue> } {
  if (action === "decline" || action === "cancel") return { action };
  if (action !== "accept") throw Error("invalid answer");
  if (info.mode === "url") {
    if (info.unsupported) throw Error("this request cannot be filled in here");
    return { action };
  }
  return { action, content: elicitContent(info, content) };
}
