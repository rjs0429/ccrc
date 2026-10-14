import { useSyncExternalStore } from "react";
import type { UploadInfo } from "../../../../broker/src/protocol.ts";
import { ApiError, api } from "../../api.ts";
import { loggedOut, toast } from "../../state.ts";

type Kind = UploadInfo["kind"];

export interface Attachment {
  key: number;
  name: string;
  kind: Kind;
  // Object URL of the image as it is sent.
  thumb?: string;
  progress: number;
  uploaded?: UploadInfo;
}

const MB = 1024 * 1024;
// The broker's limits per file and per message.
const LIMITS: Record<Kind, number> = { image: 5 * MB, pdf: 10 * MB, text: 200 * 1024 };
const LIMIT_LABEL: Record<Kind, string> = { image: "5MB", pdf: "10MB", text: "200KB" };
export const MAX_MESSAGE_BYTES = 10 * MB;
const MAX_ATTACHMENTS = 10;
const MAX_EDGE = 1568;
const KEEP_BYTES = 1.5 * MB;
const KEEP_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);
const TEXT_EXT = (
  "txt md markdown rst csv tsv log json jsonl yaml yml toml ini cfg conf env xml html htm svg css scss less js mjs cjs jsx ts mts cts tsx " +
  "vue svelte py rb go rs java kt kts scala gradle swift m c h cc cpp hpp cs php pl lua r dart ex exs hs sql graphql proto sh bash zsh fish " +
  "ps1 bat dockerfile makefile cmake tf nix diff patch lock"
).split(" ");

export const IMAGE_ACCEPT = "image/*";
export const DOCUMENT_ACCEPT = ["application/pdf", ".pdf", "text/*", ...TEXT_EXT.map((e) => `.${e}`)].join(",");

const lists = new Map<string, Attachment[]>();
const aborts = new Map<number, AbortController>();
const listeners = new Set<() => void>();
const NONE: Attachment[] = [];
let seq = 0;

function set(sessionId: string, list: Attachment[]): void {
  if (list.length) lists.set(sessionId, list);
  else lists.delete(sessionId);
  for (const l of listeners) l();
}

function patch(sessionId: string, key: number, p: Partial<Attachment>): void {
  const list = lists.get(sessionId);
  if (list?.some((a) => a.key === key)) set(sessionId, list.map((a) => (a.key === key ? { ...a, ...p } : a)));
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// The files attached to the next message of a session; they stay while the app is open.
export function useAttachments(sessionId?: string): Attachment[] {
  return useSyncExternalStore(subscribe, () => (sessionId ? lists.get(sessionId) : undefined) ?? NONE);
}

function drop(a: Attachment): void {
  aborts.get(a.key)?.abort();
  aborts.delete(a.key);
  if (a.thumb) URL.revokeObjectURL(a.thumb);
}

export function removeAttachment(sessionId: string, key: number): void {
  const list = lists.get(sessionId) ?? [];
  list.filter((a) => a.key === key).forEach(drop);
  set(sessionId, list.filter((a) => a.key !== key));
}

// Empties the list of a message that went out; its image previews pass to the caller, one per attachment.
export function takeAttachments(sessionId: string): (string | undefined)[] {
  const list = lists.get(sessionId) ?? [];
  set(sessionId, []);
  return list.map((a) => a.thumb);
}

function kindOf(file: File): Kind | undefined {
  const ext = file.name.includes(".") ? (file.name.split(".").pop() ?? "").toLowerCase() : "";
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if ((file.type.startsWith("image/") && file.type !== "image/svg+xml") || IMAGE_EXT.has(ext)) return "image";
  if (file.type.startsWith("text/") || /json|xml|yaml/.test(file.type) || TEXT_EXT.includes(ext) || !ext) return "text";
  return undefined;
}

// Large photos are scaled to fit MAX_EDGE and sent as JPEG, like other formats Claude does not read;
// a small JPEG, PNG, GIF or WebP goes as it is. What the browser cannot decode is left to the broker.
async function prepareImage(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (KEEP_TYPES.has(file.type) && file.size <= KEEP_BYTES && Math.max(w, h) <= MAX_EDGE) return file;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85))) ?? file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function uploadError(e: unknown, name: string, kind: Kind): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 413) return `파일이 너무 큽니다 (${name}, 최대 ${LIMIT_LABEL[kind]})`;
  if (status === 415) return `보낼 수 없는 파일 형식입니다 (${name})`;
  return `파일을 올리지 못했습니다 (${name})`;
}

async function upload(sessionId: string, a: Attachment, file: File, signal: AbortSignal): Promise<void> {
  let name = a.name;
  try {
    const blob = a.kind === "image" ? await prepareImage(file) : file;
    if (signal.aborted) return;
    if (blob !== file) name = `${name.replace(/\.[^.]*$/, "") || "image"}.jpg`;
    if (blob.size > LIMITS[a.kind]) throw new ApiError(413, {});
    patch(sessionId, a.key, { name, ...(a.kind === "image" ? { thumb: URL.createObjectURL(blob) } : {}) });
    const uploaded = await api.upload(blob, name, (progress) => patch(sessionId, a.key, { progress }), signal);
    patch(sessionId, a.key, { uploaded, name: uploaded.name, kind: uploaded.kind, progress: 1 });
  } catch (e) {
    if (signal.aborted) return;
    removeAttachment(sessionId, a.key);
    if (e instanceof ApiError && e.status === 401) loggedOut("expired");
    else toast(uploadError(e, name, a.kind));
  } finally {
    aborts.delete(a.key);
  }
}

// Starts uploading the picked files at once; each shows as a chip until it is sent or removed.
export function addFiles(sessionId: string, files: File[]): void {
  for (const file of files) {
    const list = lists.get(sessionId) ?? [];
    if (list.length >= MAX_ATTACHMENTS) return toast(`첨부는 ${MAX_ATTACHMENTS}개까지 할 수 있습니다`);
    const kind = kindOf(file);
    if (!kind) {
      toast(`보낼 수 없는 파일 형식입니다 (${file.name})`);
      continue;
    }
    const a: Attachment = { key: ++seq, name: file.name, kind, progress: 0 };
    const abort = new AbortController();
    aborts.set(a.key, abort);
    set(sessionId, [...list, a]);
    void upload(sessionId, a, file, abort.signal);
  }
}
