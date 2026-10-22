// The Thinking boxes opened or closed by hand; the others follow the device setting. The latest choices stay in the
// tab's sessionStorage, so a reload keeps them.
const KEY = "ccrc.thoughts";
const KEEP = 300;

function load(): Map<string, boolean> {
  try {
    const list: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(list)) return new Map();
    return new Map(list.filter((e): e is [string, boolean] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "boolean"));
  } catch {
    return new Map();
  }
}

const chosen = load();
// The choice made on the thought still streaming, with what it has said so far: its item, whose text begins with that,
// takes the choice when it comes.
let live: { text: string; open: boolean } | undefined;

export function chooseThought(id: string, open: boolean): void {
  chosen.delete(id);
  chosen.set(id, open);
  for (const old of chosen.keys()) {
    if (chosen.size <= KEEP) break;
    chosen.delete(old);
  }
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...chosen]));
  } catch {}
}

// Whether a thought's box was opened (true) or closed (false) by hand. id: its item's; a thought still streaming has
// none and finds the choice made on it by what it has said.
export function thoughtChoice(id: string | undefined, text: string): boolean | undefined {
  const streamed = live && text.startsWith(live.text) ? live.open : undefined;
  if (id === undefined) return streamed;
  if (streamed !== undefined) {
    chooseThought(id, streamed);
    live = undefined;
  }
  return chosen.get(id);
}

export function liveThought(text: string, open: boolean | undefined): void {
  live = open === undefined || !text ? undefined : { text, open };
}
