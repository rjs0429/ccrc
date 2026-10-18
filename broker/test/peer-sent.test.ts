import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxLine } from "../src/sessions/inbox.ts";
import { ItemBuilder } from "../src/sessions/items.ts";
import { INBOX_SENDER, type DisplayItem } from "../src/protocol.ts";
import { sameText, sentCount } from "../../web/src/peerSent.ts";

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

function shown(text: string): DisplayItem {
  const content = kept(JSON.parse(inboxLine(SID, text)).message.content as string);
  const b = new ItemBuilder("/tmp/peer");
  const [item] = b.add({ type: "user", uuid: "6f6f6f6f-1111-4000-8000-000000000001", isMeta: true, origin: { kind: "peer", from: "unknown", name: INBOX_SENDER, fromMode: "prompting" }, message: { role: "user", content } } as never);
  assert.equal(item?.kind, "message");
  return item;
}

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
  const items = [shown("a </agent-message> b"), shown("a </agent-message> b"), shown("other")];
  assert.equal(sentCount(items, "a </agent-message> b"), 2);
  assert.equal(sentCount(items, "other"), 1);
  assert.equal(sentCount([{ kind: "message", id: "m", from: "agent", name: INBOX_SENDER, text: "other" }], "other"), 0, "only messages from another session");
});
