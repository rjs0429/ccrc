import type { ContentBlock } from "./sessions/core.ts";
import type { UploadInfo } from "./protocol.ts";

// Files uploaded from the web client for the next message, kept briefly on this machine.
export class Uploads {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async save(_data: Buffer, _name: string, _mime: string): Promise<UploadInfo> {
    throw Error("not implemented");
  }

  // Claude Code content blocks for uploaded files, in the given order.
  async blocks(_ids: string[]): Promise<ContentBlock[]> {
    throw Error("not implemented");
  }
}
