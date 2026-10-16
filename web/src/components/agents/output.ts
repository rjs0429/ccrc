// Terminal escape sequences: CSI (colours, cursor moves), OSC (titles, links), character set picks and the other
// two-character escapes.
const ESCAPES = /(?:\x1b\[|\x9b)[0-9:;<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+][0-~]|\x1b[@-Z\\^_0-9=>c]/g;
// Characters that reorder the text around them are shown by their code instead.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export const SHELL_KINDS = new Set(["local_bash", "monitor_mcp", "monitor_ws"]);

// A shell's output as a terminal would leave it: an output that begins mid-line drops that partial line, escape
// sequences go, and each line keeps what follows its last carriage return, as a progress bar redrawn in place.
export function cleanOutput(text: string, truncated: boolean): string {
  const nl = text.indexOf("\n");
  const rest = truncated && nl !== -1 && nl < text.length - 1 ? text.slice(nl + 1) : text;
  const start = truncated && rest === text ? rest.replace(/^�+/, "") : rest;
  return start
    .replace(ESCAPES, "")
    .replace(BIDI, (c) => `\\u${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
    .split("\n")
    .map((line) => {
      const l = line.endsWith("\r") ? line.slice(0, -1) : line;
      return l.slice(l.lastIndexOf("\r") + 1).replace(CONTROLS, "");
    })
    .join("\n");
}
