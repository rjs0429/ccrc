import fs from "node:fs";
import { paths, writeFileAtomic } from "./config.ts";

export interface StoredUser {
  id: string;
  passwordHash: string;
  changedAt: string;
}

// verifiedAt: when a passkey last confirmed the login (passkeys.ts).
export interface StoredLease {
  tokenHash: string;
  device: string;
  createdAt: number;
  lastSeen: number;
  verifiedAt?: number;
}

export interface StoredState {
  user?: StoredUser;
  lockout: { failures: number; lockedUntil: number };
  lease?: StoredLease;
}

export class Store {
  state: StoredState;
  private file: string;

  constructor(file = paths.credentialsFile) {
    this.file = file;
    this.state = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, "utf8")) as StoredState)
      : { lockout: { failures: 0, lockedUntil: 0 } };
  }

  // Credentials may change from the `ccrc passwd` command while the server runs.
  reload(): void {
    if (fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredState;
  }

  save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 2) + "\n");
  }
}
