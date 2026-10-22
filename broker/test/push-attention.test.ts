import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { NOTICE_KINDS, REQUEST_KINDS, settled, type ShownNotification } from "../src/push/attention.ts";
import type { PushAttention } from "../src/push/types.ts";

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-3333-4444-8555-666666666666";
const C = "33333333-4444-4555-8666-777777777777";
const T = 1_792_627_200_000;

const note = (tag: string, at?: number): ShownNotification => ({ tag, data: { url: "/", ...(at === undefined ? {} : { at }) } });
const state = (unseen: string[], waiting: string[] = [], at = T): PushAttention => ({ at, unseen, waiting });
const closes = (n: ShownNotification, list: ShownNotification[], s?: PushAttention, viewing?: string) => settled(n, [n, ...list], s, viewing);

test("a notice of a session stays while the session is unread, a request while one waits", () => {
  for (const kind of NOTICE_KINDS) {
    assert.equal(closes(note(`${A}:${kind}`, T - 1), [], state([A])), false, kind);
    assert.equal(closes(note(`${A}:${kind}`, T - 1), [], state([B], [A])), true, `${kind}: read, though a request waits`);
  }
  for (const kind of REQUEST_KINDS) {
    assert.equal(closes(note(`${A}:${kind}`, T - 1), [], state([], [A])), false, kind);
    assert.equal(closes(note(`${A}:${kind}`, T - 1), [], state([A], [B])), true, `${kind}: answered, though unread`);
  }
});

test("the state judges only notifications made before it; one that does not say when is older than any", () => {
  assert.equal(closes(note(`${A}:end`, T), [], state([])), false, "made as the state was taken");
  assert.equal(closes(note(`${A}:end`, T + 5), [], state([])), false, "made after");
  assert.equal(closes(note(`${A}:end`), [], state([])), true, "from an older broker");
  assert.equal(closes(note(`${A}:end`, T - 1), []), false, "without a state");
});

test("a newer notification of the same tag takes the place of older ones, state or not", () => {
  const list = [note(`${A}:permission`, T - 30), note(`${A}:permission`, T - 20), note(`${A}:permission`, T - 10)];
  assert.deepEqual(
    list.map((n) => settled(n, list)),
    [true, true, false],
  );
  assert.deepEqual(
    list.map((n) => settled(n, list, state([], [A]))),
    [true, true, false],
    "still waiting: the newest stays",
  );
  assert.equal(settled(note("test"), [note("test"), note("test", T)]), true, "an older test notification");
  assert.equal(settled(note("ccrc-update", T), [note("ccrc-update", T), note("ccrc-update", T)]), false, "made at the same time");
  assert.equal(settled(note(`${A}:end`, T - 1), [note(`${B}:end`, T)], state([A])), false, "another tag");
});

test("the session the app shows loses its notifications of every kind made before the state", () => {
  const s = state([A], [A]);
  assert.equal(closes(note(`${A}:end`, T - 1), [], s, A), true);
  assert.equal(closes(note(`${A}:permission`, T - 1), [], s, A), true, "a request still waiting");
  assert.equal(closes(note(`${A}:fork`, T - 1), [], s, A), true, "a kind this does not know");
  assert.equal(closes(note(`${A}:end`, T + 1), [], s, A), false, "made after the state");
  assert.equal(closes(note(`${B}:end`, T - 1), [], state([B]), A), false, "another session");
});

test("kinds it does not know and tags without a session stay but for a newer one of their tag", () => {
  assert.equal(closes(note(`${A}:fork`, T - 1), [], state([])), false);
  assert.equal(closes(note("test", T - 1), [], state([])), false);
  assert.equal(closes(note("ccrc-update", T - 1), [], state([])), false);
  assert.equal(closes(note(":end", T - 1), [], state([])), false);
  assert.equal(closes({ tag: "", data: null }, [], state([])), false);
  assert.equal(closes({ tag: `${A}:end` }, [], state([])), true, "no data at all");
});

// The service worker, run against an iOS-like notification center: a notification of a tag shown before is not
// replaced, and close() does nothing within `lifetime` ms of showing it.
const SOURCE = fs.readFileSync(new URL("../../web/public/sw.js", import.meta.url), "utf8");

interface Shown {
  title: string;
  tag: string;
  body: string;
  data: { url?: string; at?: number; shown?: number };
  shownAt: number;
  close(): void;
}

function worker(lifetime = 30_000) {
  const clock = { now: 1_000_000 };
  const center: Shown[] = [];
  const calls: string[] = [];
  const badges: (number | "clear")[] = [];
  let listFails = false;
  const handlers = new Map<string, (event: unknown) => void>();
  const self = {
    addEventListener: (t: string, f: (event: unknown) => void) => handlers.set(t, f),
    location: { origin: "https://laptop.example.ts.net" },
    navigator: { setAppBadge: async (n: number) => void badges.push(n), clearAppBadge: async () => void badges.push("clear") },
    registration: {
      showNotification: async (title: string, o: { tag?: string; body?: string; data: Shown["data"] }) => {
        calls.push("show");
        const n: Shown = {
          title,
          tag: o.tag ?? "",
          body: o.body ?? "",
          data: structuredClone(o.data),
          shownAt: clock.now,
          close() {
            if (clock.now - n.shownAt < lifetime) return;
            const i = center.indexOf(n);
            if (i >= 0) center.splice(i, 1);
          },
        };
        center.push(n);
      },
      getNotifications: async () => {
        calls.push("list");
        if (listFails) throw new DOMException("not now", "InvalidStateError");
        return center.slice();
      },
    },
  };
  const fakeDate = { now: () => clock.now };
  const exposed = new Function("self", "caches", "fetch", "setTimeout", "Date", `${SOURCE}\nreturn { settled };`)(self, {}, () => {}, setTimeout, fakeDate) as {
    settled: (n: ShownNotification, list: ShownNotification[], state?: PushAttention) => boolean;
  };
  const push = async (data: (() => unknown) | object) => {
    const waits: Promise<unknown>[] = [];
    handlers.get("push")!({ data: { json: typeof data === "function" ? data : () => data }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    return Promise.allSettled(waits);
  };
  return {
    clock,
    center,
    calls,
    badges,
    push,
    failList: (on: boolean) => (listFails = on),
    tags: () => center.map((n) => `${n.tag}@${n.data.at}`),
    settled: exposed.settled,
  };
}

const payload = (tag: string, at: number, unseen: string[], waiting: string[] = []) => ({
  title: "Fix the invoice export",
  body: "작업을 마쳤습니다",
  tag,
  data: { url: `/#/s/${tag.split(":")[0]}`, at },
  badge: new Set([...unseen, ...waiting]).size,
  attention: { at, unseen, waiting },
});

test("the worker shows a push's notification first and looks at the others only then, with when it showed", async () => {
  const sw = worker();
  const done = await sw.push(payload(`${A}:end`, T, [A]));
  assert.deepEqual(done.map((r) => r.status), ["fulfilled"]);
  assert.deepEqual(sw.calls, ["show", "list"]);
  assert.deepEqual(sw.center[0].data, { url: `/#/s/${A}`, at: T, shown: sw.clock.now });
  assert.deepEqual(sw.badges, [1]);
});

test("the worker's push event never fails for its tidying, and a push that is not JSON still shows", async () => {
  const sw = worker();
  sw.failList(true);
  const done = await sw.push(payload(`${A}:end`, T, [A]));
  assert.deepEqual(done.map((r) => r.status), ["fulfilled"]);
  assert.equal(sw.center.length, 1);
  sw.failList(false);
  await sw.push(() => {
    throw new SyntaxError("Unexpected token");
  });
  assert.deepEqual(sw.center.map((n) => [n.title, n.tag, n.data.url]), [
    ["Fix the invoice export", `${A}:end`, `/#/s/${A}`],
    ["ccrc", "", "/"],
  ]);
});

test("on iOS a newer notification of a tag closes the older ones once they may be closed", async () => {
  const sw = worker();
  await sw.push(payload(`${A}:permission`, T, [], [A]));
  sw.clock.now += 5_000;
  await sw.push(payload(`${A}:permission`, T + 5_000, [], [A]));
  assert.deepEqual(sw.tags(), [`${A}:permission@${T}`, `${A}:permission@${T + 5_000}`], "too soon for iOS to close the first");
  sw.clock.now += 31_000;
  await sw.push(payload(`${A}:permission`, T + 36_000, [], [A]));
  assert.deepEqual(sw.tags(), [`${A}:permission@${T + 36_000}`]);
  await sw.push({ title: "ccrc", body: "테스트 알림입니다", tag: "test", data: { url: "/#/settings/alerts", at: T + 36_000 } });
  sw.clock.now += 31_000;
  await sw.push({ title: "ccrc", body: "테스트 알림입니다", tag: "test", data: { url: "/#/settings/alerts", at: T + 67_000 } });
  assert.deepEqual(sw.tags(), [`${A}:permission@${T + 36_000}`, `test@${T + 67_000}`], "a test notification as well");
});

test("the next push closes what was read or answered elsewhere and keeps what still counts", async () => {
  const sw = worker();
  await sw.push(payload(`${A}:permission`, T, [], [A]));
  await sw.push(payload(`${B}:end`, T + 1, [B], [A]));
  await sw.push(payload(`${C}:claude`, T + 2, [B, C], [A]));
  sw.clock.now += 31_000;
  await sw.push(payload(`${C}:file`, T + 40_000, [C], [A]));
  assert.deepEqual(sw.tags(), [`${A}:permission@${T}`, `${C}:claude@${T + 2}`, `${C}:file@${T + 40_000}`], "B read in VS Code");
  sw.clock.now += 31_000;
  await sw.push(payload(`${B}:end`, T + 80_000, [B], []));
  assert.deepEqual(sw.tags(), [`${B}:end@${T + 80_000}`], "A answered, C read");
});

test("without the sessions, or with a shape it does not know, the worker closes older ones of a tag only", async () => {
  const sw = worker();
  await sw.push(payload(`${A}:end`, T, [A]));
  await sw.push(payload(`${B}:end`, T + 1, [A, B]));
  sw.clock.now += 31_000;
  const { attention: _, ...bare } = payload(`${B}:end`, T + 40_000, []);
  await sw.push(bare);
  assert.deepEqual(sw.tags(), [`${A}:end@${T}`, `${B}:end@${T + 40_000}`]);
  for (const attention of [{ at: String(T + 50_000), unseen: [], waiting: [] }, { at: T + 50_000, unseen: A, waiting: [] }, { at: T + 50_000, unseen: [], waiting: [1] }, null]) {
    await sw.push({ ...payload(`${C}:end`, T + 50_000, []), attention });
    assert.ok(sw.tags().includes(`${A}:end@${T}`), JSON.stringify(attention));
  }
});

test("the worker's rule is the app's rule", () => {
  const sw = worker();
  const kinds = [...NOTICE_KINDS, ...REQUEST_KINDS, "fork"];
  const states = [undefined, state([]), state([A]), state([], [A]), state([A], [A]), state([B], [B]), state([A], [], T - 10)];
  let cases = 0;
  for (const kind of kinds) {
    for (const at of [undefined, T - 1, T, T + 1]) {
      for (const others of [[], [note(`${A}:${kind}`, T - 5)], [note(`${A}:${kind}`, T + 5)], [note(`${B}:${kind}`, T + 5)]]) {
        for (const s of states) {
          const n = note(`${A}:${kind}`, at);
          const list = [n, ...others];
          assert.equal(sw.settled(n, list, s), settled(n, list, s), JSON.stringify({ n, others, s }));
          cases++;
        }
      }
    }
  }
  for (const tag of ["test", "ccrc-update", "", ":end"]) {
    for (const s of states) assert.equal(sw.settled(note(tag, T - 1), [note(tag, T - 1), note(tag, T)], s), settled(note(tag, T - 1), [note(tag, T - 1), note(tag, T)], s), tag);
  }
  assert.ok(cases > 800);
});
