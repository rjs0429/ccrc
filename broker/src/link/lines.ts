// Splits a byte stream at "\n" without decoding it. Lines come without the newline, empty ones included.
export class LineSplitter {
  private parts: Buffer[] = [];
  private onLine: (line: Buffer) => void;

  constructor(onLine: (line: Buffer) => void) {
    this.onLine = onLine;
  }

  push(chunk: Buffer): void {
    let start = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
      let line = chunk.subarray(start, nl);
      if (this.parts.length) {
        this.parts.push(line);
        line = Buffer.concat(this.parts);
        this.parts = [];
      }
      start = nl + 1;
      this.onLine(line);
    }
    if (start < chunk.length) this.parts.push(chunk.subarray(start));
  }

  // Delivers a last line that had no newline.
  end(): void {
    if (!this.parts.length) return;
    const line = Buffer.concat(this.parts);
    this.parts = [];
    this.onLine(line);
  }
}

export function parseLine(line: Buffer | string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(String(line));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
