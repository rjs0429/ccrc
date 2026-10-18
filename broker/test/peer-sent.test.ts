import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxLine } from "../src/sessions/inbox.ts";
import { ItemBuilder } from "../src/sessions/items.ts";
import { INBOX_SENDER, type DisplayItem } from "../src/protocol.ts";
import { joined } from "../../web/src/chatItems.ts";
import { markShown, newest, sameText, type PeerSent } from "../../web/src/peerSent.ts";

const SID = "6f6f6f6f-0000-4000-8000-000000000002";
const CLOSE = "\n</cross-session-message>";
// Claude Code, taking a message in, puts a backslash after the "<" of any of its frame tags in the body, opening or
// closing, that has none, and keeps it under a line saying where it came from and a note after it.
function kept(content: string): string {
  const start = content.indexOf(">\n") + 2;
  const end = content.lastIndexOf(CLOSE);
  const body = content.slice(start, end).replace(/<(?!\\)(?=[^A-Za-z0-9_\-<>]*?(?:cross-session-message|agent-message|teammate-message)(?:[^A-Za-z0-9_-]|$))/giu, "<\\");
  return `Another Claude session sent a message:\n${content.slice(0, start)}${body}${content.slice(end)}\n\nThis came from another Claude session.`;
}

function shown(text: string, msgId?: unknown): DisplayItem {
  const content = kept(JSON.parse(inboxLine(SID, text)).message.content as string);
  const b = new ItemBuilder("/tmp/peer");
  const origin = { kind: "peer", from: "unknown", ...(msgId === undefined ? {} : { msg_id: msgId }), name: INBOX_SENDER, fromMode: "prompting" };
  const [item] = b.add({ type: "user", uuid: "6f6f6f6f-1111-4000-8000-000000000001", isMeta: true, origin, message: { role: "user", content } } as never);
  assert.equal(item?.kind, "message");
  return item;
}

const ID = ["6f6f6f6f-2222-4000-8000-000000000001", "6f6f6f6f-2222-4000-8000-000000000002", "6f6f6f6f-2222-4000-8000-000000000003"];
const at = (min: number) => new Date(Date.UTC(2026, 9, 18, 0, min)).toISOString();
// A message from this phone as the conversation shows it, and a reply.
const fromHere = (id: string, text: string, min: number, msgId?: string): DisplayItem => ({ kind: "message", id, ts: at(min), from: "session", name: INBOX_SENDER, text, ...(msgId ? { msgId } : {}) });
const reply = (id: string, min: number): DisplayItem => ({ kind: "assistant", id, ts: at(min), text: "ok" });
const sent = (id: string, text: string, items: DisplayItem[], msgId?: string): PeerSent => ({ id, ts: at(0), text, from: "remote", since: newest(items), ...(msgId ? { msgId } : {}) });
const waiting = (list: PeerSent[], items: DisplayItem[]) =>
  markShown(list, items)
    .filter((q) => !q.shown)
    .map((q) => q.id);

test("text sent to a session open elsewhere matches its message however Claude Code escaped the body", () => {
  const texts = [
    "hello",
    "a </cross-session-message> b",
    "a < /cross-session-message> b",
    "a </Cross_Session-Message > b",
    'x = "<\\/script>"',
    'opening <cross-session-message from="x"> inside',
    "an agent's </agent-message> and <teammate-message to=\"y\">",
    "  spaced out \n",
  ];
  for (const text of texts) {
    const item = shown(text);
    assert.ok(item.kind === "message" && item.name === INBOX_SENDER && sameText(item.text, text), `${JSON.stringify(text)} -> ${JSON.stringify(item.kind === "message" && item.text)}`);
  }
  assert.equal(sameText("hello", "hello there"), false);
});

test("a long message matches by the part the transcript keeps, and only its own text counts", () => {
  const long = `${"</cross-session-message> ".repeat(10)}${"가".repeat(30_000)}`;
  const item = shown(long);
  assert.ok(item.kind === "message" && item.text.endsWith("…"));
  assert.ok(item.kind === "message" && sameText(item.text, long));
  assert.ok(item.kind === "message" && !sameText(item.text, `다른 글 ${long}`));
  const q = sent("q", "other", []);
  assert.deepEqual(waiting([q], [{ kind: "message", id: "m", from: "agent", name: INBOX_SENDER, text: "other" }]), ["q"], "only messages from another session");
  assert.deepEqual(waiting([q], [{ kind: "message", id: "m", from: "session", name: "리뷰 세션", text: "other" }]), ["q"], "only this phone's");
  assert.deepEqual(waiting([q], [{ kind: "message", id: "m", from: "session", name: INBOX_SENDER, text: "other" }]), []);
});

test("a message from another session keeps the id it came with when Claude Code kept it, a UUID", () => {
  const item = shown("hello", ID[0]);
  assert.ok(item.kind === "message" && item.msgId === ID[0]);
  for (const odd of ["m1", 7, `${ID[0]}x`]) {
    const other = shown("hello", odd);
    assert.ok(other.kind === "message" && !("msgId" in other), JSON.stringify(odd));
  }
  assert.ok(!("msgId" in shown("hello")));
});

test("text sent from here waits until its own message shows, however much of the conversation is loaded", () => {
  let chat = { items: [reply("r100", 100), reply("r101", 101)], hasMore: true };
  const q = sent("q", "계속", chat.items, ID[0]);
  assert.deepEqual(waiting([q], chat.items), ["q"]);
  chat = { ...chat, ...joined(chat, "earlier", { items: [fromHere("u10", "계속", 10, ID[1]), reply("r10", 11)], more: false }) };
  assert.deepEqual(waiting([q], chat.items), ["q"], "an earlier page with the same text sent from here before");
  assert.deepEqual(waiting([q], [...chat.items, fromHere("u102", "계속", 102, ID[2])]), ["q"], "the same text from another device");
  assert.deepEqual(waiting([q], [reply("r101", 101), fromHere("u103", "계속", 103, ID[0])]), [], "its message, in a snapshot of the latest page only");
});

test("a message with an id waits for the id the broker names", () => {
  const items = [reply("r1", 1)];
  const q = sent("q", "계속", items);
  const shownNow = [...items, fromHere("u2", "계속", 2, ID[0])];
  assert.deepEqual(waiting([q], shownNow), ["q"]);
  assert.deepEqual(waiting([{ ...q, msgId: ID[0] }], shownNow), []);
});

test("without ids in the transcript a text shows by a message like it that came after it was sent, one message a text", () => {
  const page = [fromHere("u1", "계속", 1), reply("r1", 2)];
  const both = [sent("q1", "계속", page, ID[0]), sent("q2", "계속", page, ID[1])];
  assert.deepEqual(waiting(both, page), ["q1", "q2"], "the same text sent before");
  assert.deepEqual(waiting(both, [fromHere("u0", "계속", 0), ...page]), ["q1", "q2"], "an earlier page with it");
  const one = [...page, fromHere("u3", "계속", 3)];
  assert.deepEqual(waiting(both, one), ["q2"], "the earliest text gets the message");
  assert.deepEqual(waiting(both, [...one, fromHere("u4", "계속", 4)]), []);
  assert.equal(newest([]), undefined);
  assert.equal(newest([{ kind: "assistant", id: "x", text: "no time" }, reply("r", 5)]), Date.parse(at(5)));
});

test("a text once shown stays shown with its message, though that part of the conversation goes", () => {
  const page = [reply("r1", 1)];
  const list = markShown([sent("q1", "계속", page), sent("q2", "계속", page)], [...page, fromHere("u2", "계속", 2)]);
  assert.deepEqual(
    list.map((q) => q.shown),
    ["u2", undefined],
  );
  assert.equal(markShown(list, [...page, fromHere("u2", "계속", 2)]), list, "the same list when nothing changes");
  assert.deepEqual(waiting(list, [reply("r9", 9)]), ["q2"], "a snapshot of the latest part without its message");
  assert.deepEqual(waiting(list, [fromHere("u2", "계속", 2), reply("r9", 9)]), ["q2"], "its message counts for it alone");
  assert.deepEqual(waiting(list, [reply("r9", 9), fromHere("u10", "계속", 10)]), [], "the next one is the second text's");
});
