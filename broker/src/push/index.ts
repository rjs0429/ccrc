import type { Hub } from "../hub.ts";
import type { SessionManager } from "../sessions/manager.ts";

// Web Push notifications to subscribed devices.
export class Push {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  watch(_manager: SessionManager, _hub: Hub): void {}

  close(): void {}
}
