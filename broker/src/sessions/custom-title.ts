import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../config.ts";

// Names a session without a process the way Claude Code saves a name: a custom-title row appended in one write,
// on a line of its own even after a row a stopped process left unfinished, then the title file Claude Code keeps
// beside the transcript. The last custom-title row is the name every session list shows.
export function writeTitle(file: string, sessionId: string, title: string): void {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND);
  } catch {
    throw Error("unknown session");
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (!size) throw Error("unknown session");
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    const row = JSON.stringify({ type: "custom-title", customTitle: title, sessionId }) + "\n";
    fs.writeSync(fd, last[0] === 0x0a ? row : "\n" + row);
  } finally {
    fs.closeSync(fd);
  }
  try {
    writeFileAtomic(path.join(path.dirname(file), sessionId, "custom-title.json"), JSON.stringify({ customTitle: title }));
  } catch {}
}
