import assert from "node:assert/strict";
import { test } from "node:test";

// A browser's session history for one document, as Chrome keeps it: pushState drops the entries ahead, a traversal
// lands a moment later on the entry counted from where the page was when it was asked, and setting location.hash
// pushes an entry without state, with popstate then hashchange.
class Browser {
  entries: { url: string; state: unknown }[];
  index = 0;
  scrollRestoration = "auto";
  private on = new Map<string, Set<(e: unknown) => void>>();
  constructor(url: string) {
    this.entries = [{ url, state: null }];
  }
  get href(): string {
    return this.entries[this.index].url;
  }
  get state(): unknown {
    return structuredClone(this.entries[this.index].state);
  }
  get length(): number {
    return this.entries.length;
  }
  url(u: string): string {
    return new URL(u, this.href).href;
  }
  listen(type: string, fn: (e: unknown) => void): void {
    if (!this.on.has(type)) this.on.set(type, new Set());
    this.on.get(type)!.add(fn);
  }
  fire(type: string, e: unknown = {}): void {
    for (const fn of this.on.get(type) ?? []) fn(e);
  }
  pushState(state: unknown, _: string, url: string): void {
    this.entries.splice(this.index + 1);
    this.entries.push({ url: this.url(url), state: structuredClone(state) });
    this.index++;
  }
  replaceState(state: unknown, _: string, url: string): void {
    this.entries[this.index] = { url: this.url(url), state: structuredClone(state) };
  }
  go(n: number): void {
    const to = this.index + n;
    setTimeout(() => {
      if (to < 0 || to >= this.entries.length) return;
      const hash = new URL(this.href).hash;
      this.index = to;
      this.fire("popstate", { state: this.state });
      if (new URL(this.href).hash !== hash) this.fire("hashchange");
    }, 1);
  }
  setHash(h: string): void {
    const u = new URL(this.href);
    u.hash = h;
    this.entries.splice(this.index + 1);
    this.entries.push({ url: u.href, state: null });
    this.index++;
    this.fire("popstate", { state: null });
    this.fire("hashchange");
  }
  hashes(): string[] {
    return this.entries.map((e) => new URL(e.url).hash || "#/");
  }
}

type Route = { name: string; sessionId?: string; page?: string; part?: string };
interface Nav {
  startNav: () => void;
  listen: (fn: () => void) => () => void;
  parseRoute: (hash?: string) => Route;
  routeHash: (r: Route) => string;
  lineage: (r: Route) => Route[];
  openLayer: (close: () => void) => { dismiss: () => void; release: () => void };
  dismissTop: () => void;
  nav: { open: (r: Route) => void; replace: (r: Route) => void; top: (r: Route) => void; back: () => void };
}

let loads = 0;
// A fresh page at url, with its own copy of the module; under: the entries the history holds before it.
async function page(url: string, state: unknown = null, under: { url: string; state: unknown }[] = []): Promise<{ b: Browser; m: Nav; shown: string[] }> {
  const b = new Browser(url);
  b.entries = [...under, { url, state }];
  b.index = under.length;
  const g = globalThis as Record<string, unknown>;
  g.window = { addEventListener: (t: string, fn: (e: unknown) => void) => b.listen(t, fn), setTimeout };
  g.document = { readyState: "complete", visibilityState: "visible", activeElement: null, addEventListener: (t: string, fn: (e: unknown) => void) => b.listen(`doc:${t}`, fn) };
  g.HTMLElement = class {};
  g.history = b;
  g.location = {
    get href() {
      return b.href;
    },
    get hash() {
      return new URL(b.href).hash;
    },
    get pathname() {
      return new URL(b.href).pathname;
    },
    get search() {
      return new URL(b.href).search;
    },
  };
  const file = "../../web/src/nav.ts";
  const m = (await import(`${file}?page=${++loads}`)) as Nav;
  const shown: string[] = [];
  m.listen(() => shown.push(new URL(b.href).hash || "#/"));
  m.startNav();
  await idle();
  return { b, m, shown };
}

const idle = () => new Promise((r) => setTimeout(r, 30));
const chat = (n: number): Route => ({ name: "chat", sessionId: `5d4a0000-4444-4444-8444-${String(n).padStart(12, "0")}` });
const H = (n: number) => `#/s/5d4a0000-4444-4444-8444-${String(n).padStart(12, "0")}`;
const st = (b: Browser) => b.entries[b.index].state as { below: number; layers?: number; layer?: string; base?: boolean; keep?: unknown };

test("routes: parse, hash and the screens under each", async () => {
  const { m } = await page("http://app.example.com/#/");
  assert.deepEqual(m.parseRoute("#/settings/claude/permissions"), { name: "settings", page: "claude", part: "permissions" });
  assert.deepEqual(m.parseRoute("#/nothing"), { name: "home" });
  assert.equal(m.routeHash({ name: "settings", page: "alerts" }), "#/settings/alerts");
  assert.deepEqual(
    m.lineage({ name: "settings", page: "claude", part: "permissions" }).map(m.routeHash),
    ["#/", "#/settings", "#/settings/claude", "#/settings/claude/permissions"],
  );
  assert.deepEqual(m.lineage(chat(1)).map(m.routeHash), ["#/", H(1)]);
});

test("a deep start stacks home and each level under it; back goes up a level at a time", async () => {
  const { b, m } = await page("http://app.example.com/?tap=1#/settings/claude");
  assert.equal(b.scrollRestoration, "manual");
  assert.deepEqual(b.hashes(), ["#/", "#/settings", "#/settings/claude"]);
  assert.equal(b.index, 2);
  assert.ok(!b.entries[0].url.includes("tap=") && b.entries[2].url.includes("tap=1"));
  m.nav.back();
  await idle();
  assert.equal(new URL(b.href).hash, "#/settings");
  m.nav.back();
  await idle();
  assert.equal(b.index, 0);
  m.nav.back();
  await idle();
  assert.equal(b.index, 0);
});

test("open pushes, back steps back, home is always the bottom", async () => {
  const { b, m, shown } = await page("http://app.example.com/");
  m.nav.open(chat(1));
  m.nav.back();
  await idle();
  m.nav.open(chat(2));
  m.nav.back();
  await idle();
  m.nav.open({ name: "settings" });
  m.nav.open({ name: "settings", page: "alerts" });
  m.nav.back();
  await idle();
  m.nav.back();
  await idle();
  m.nav.open(chat(3));
  assert.equal(b.index, 1);
  assert.deepEqual(b.hashes().slice(0, 2), ["#/", H(3)]);
  assert.deepEqual(shown, [H(1), "#/", H(2), "#/", "#/settings", "#/settings/alerts", "#/settings", "#/", H(3)]);
});

test("top: a notification's chat goes right over home from anywhere", async () => {
  const { b, m } = await page("http://app.example.com/");
  m.nav.open({ name: "settings" });
  m.nav.open({ name: "settings", page: "alerts" });
  m.nav.top(chat(1));
  await idle();
  assert.equal(b.index, 1);
  assert.equal(new URL(b.href).hash, H(1));
  assert.equal(st(b).below, 1);
  m.nav.top(chat(2));
  await idle();
  assert.equal(b.index, 1);
  assert.equal(new URL(b.href).hash, H(2));
  m.nav.back();
  await idle();
  assert.equal(b.index, 0);
  m.nav.top(chat(3));
  assert.equal(b.index, 1);
});

test("a layer has its own entry: the back closes it, release after that steps no further", async () => {
  const { b, m } = await page("http://app.example.com/#" + H(1).slice(1));
  let closed = 0;
  const l = m.openLayer(() => closed++);
  await idle();
  assert.equal(b.index, 2);
  assert.equal(st(b).layers, 1);
  b.go(-1);
  await idle();
  assert.equal(closed, 1);
  l.release();
  await idle();
  assert.equal(b.index, 1);
  const l2 = m.openLayer(() => closed++);
  await idle();
  l2.dismiss();
  assert.equal(closed, 1);
  await idle();
  assert.equal(closed, 2);
  assert.equal(b.index, 1);
});

test("a layer that closes as another opens hands it its entry", async () => {
  const { b, m } = await page("http://app.example.com/#" + H(1).slice(1));
  const menu = m.openLayer(() => {});
  await idle();
  const before = b.entries.length;
  menu.release();
  const sheet = m.openLayer(() => {});
  await idle();
  assert.equal(b.entries.length, before);
  assert.equal(b.index, 2);
  sheet.release();
  await idle();
  assert.equal(b.index, 1);
});

test("a layer opened while the history steps back waits for it to land", async () => {
  const { b, m } = await page("http://app.example.com/#" + H(1).slice(1));
  const a = m.openLayer(() => {});
  await idle();
  a.release();
  await Promise.resolve();
  const c = m.openLayer(() => {});
  await idle();
  assert.equal(b.index, 2);
  assert.equal(b.entries.length, 3);
  assert.equal(st(b).layers, 1);
  c.release();
  await idle();
});

test("a screen opened from a layer takes the layer's place; one put in place of the screen takes both", async () => {
  const { b, m } = await page("http://app.example.com/#" + H(1).slice(1));
  m.openLayer(() => assert.fail("a layer the screen takes with it is not closed"));
  await idle();
  m.nav.open({ name: "new" });
  await idle();
  assert.deepEqual(b.hashes(), ["#/", H(1), "#/new"]);
  assert.equal(st(b).below, 2);
  assert.equal(st(b).layers, undefined);
  m.nav.back();
  await idle();
  m.openLayer(() => assert.fail("not closed either"));
  await idle();
  m.nav.replace(chat(2));
  await idle();
  assert.equal(b.index, 1);
  assert.equal(new URL(b.href).hash, H(2));
});

test("a reload over a layer steps back to its screen", async () => {
  const { b, m } = await page(`http://app.example.com/${H(1)}`, { ccrc: 1, below: 2, layer: "old.1", layers: 1 }, [
    { url: "http://app.example.com/#/", state: { ccrc: 1, below: 0 } },
    { url: `http://app.example.com/${H(1)}`, state: { ccrc: 1, below: 1 } },
  ]);
  assert.equal(b.index, 1);
  assert.equal(st(b).layers, undefined);
  m.nav.back();
  await idle();
  assert.equal(b.index, 0);
});

test("a page whose entries below are gone starts over from home", async () => {
  const { b, m } = await page("http://app.example.com/#/settings/claude", { ccrc: 1, below: 2 });
  assert.deepEqual(b.hashes(), ["#/", "#/settings", "#/settings/claude"]);
  m.nav.back();
  await idle();
  assert.equal(new URL(b.href).hash, "#/settings");
});

test("an address set from outside shows its screen, whose back goes to its parent", async () => {
  const { b, m, shown } = await page("http://app.example.com/");
  b.setHash("#/settings/alerts");
  await idle();
  assert.equal(st(b).base, true);
  assert.equal(st(b).below, 0);
  assert.equal(shown.at(-1), "#/settings/alerts");
  m.nav.back();
  await idle();
  assert.equal(new URL(b.href).hash, "#/settings");
  m.nav.back();
  await idle();
  assert.equal(new URL(b.href).hash, "#/");
  assert.equal(st(b).base, undefined);
});

test("a step forward onto a layer that has closed comes back", async () => {
  const { b, m } = await page("http://app.example.com/#" + H(1).slice(1));
  let closed = 0;
  const l = m.openLayer(() => closed++);
  await idle();
  l.dismiss();
  await idle();
  l.release();
  await idle();
  assert.equal(b.index, 1);
  b.go(1);
  await idle();
  await idle();
  assert.equal(b.index, 1);
  assert.equal(closed, 1);
});
