// The Thinking boxes opened or closed by hand; the others follow the device setting. The latest choices stay in the
// tab's sessionStorage, so a reload keeps them.
const KEY = "ccrc.thoughts";
const KEEP = 300;
// The choice made on each session's thought still streaming, with the start of what it has said: its item, whose text
// begins with that, takes the choice when it comes. LIVE_TEXT is enough to tell a session's thoughts apart.
const LIVE_KEY = "ccrc.thoughts.live";
const LIVE_KEEP = 30;
const LIVE_TEXT = 400;

interface Live {
  text: string;
  open: boolean;
}

function load<T>(key: string, valid: (v: unknown) => boolean): Map<string, T> {
  try {
    const list: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    if (!Array.isArray(list)) return new Map();
    return new Map(list.filter((e): e is [string, T] => Array.isArray(e) && typeof e[0] === "string" && valid(e[1])));
  } catch {
    return new Map();
  }
}

function save(key: string, map: Map<string, unknown>, keep: number): void {
  for (const old of map.keys()) {
    if (map.size <= keep) break;
    map.delete(old);
  }
  try {
    sessionStorage.setItem(key, JSON.stringify([...map]));
  } catch {}
}

const chosen = load<boolean>(KEY, (v) => typeof v === "boolean");
const live = load<Live>(LIVE_KEY, (v) => {
  const l = v as Partial<Live> | null;
  return typeof l === "object" && l !== null && typeof l.text === "string" && l.text !== "" && typeof l.open === "boolean";
});

export function chooseThought(id: string, open: boolean): void {
  chosen.delete(id);
  chosen.set(id, open);
  save(KEY, chosen, KEEP);
}

// Whether a thought's box was opened (true) or closed (false) by hand. id: its item's; a thought still streaming has
// none and finds the choice made on it in its session by what it has said.
export function thoughtChoice(id: string | undefined, text: string, session?: string): boolean | undefined {
  const made = session === undefined ? undefined : live.get(session);
  const streamed = made && text.startsWith(made.text) ? made.open : undefined;
  if (id === undefined) return streamed;
  if (session !== undefined && streamed !== undefined) {
    chooseThought(id, streamed);
    live.delete(session);
    save(LIVE_KEY, live, LIVE_KEEP);
  }
  return chosen.get(id);
}

// What a session's streaming thought has said and the choice made on it by hand. A thought there with no choice comes
// after the one chosen, so that choice goes; other sessions keep theirs.
export function liveThought(session: string, text: string, open: boolean | undefined): void {
  const was = live.get(session);
  const now = open === undefined || !text ? undefined : { text: text.slice(0, LIVE_TEXT), open };
  if (was?.text === now?.text && was?.open === now?.open) return;
  live.delete(session);
  if (now) live.set(session, now);
  save(LIVE_KEY, live, LIVE_KEEP);
}
