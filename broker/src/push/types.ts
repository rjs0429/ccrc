// Shapes the web client shares with the broker's push notifications.

// Which turn ends a device hears of: on sessions the remote user sent to or answered in lately, on all sessions, or none.
export type TurnEndMode = "remote" | "all" | "off";
export const TURN_END_MODES: TurnEndMode[] = ["remote", "all", "off"];

// Notification settings of one subscribed device.
export interface PushPrefs {
  // VS Code sessions: seconds a request waits first, so an answer at the laptop does not buzz the phone.
  vscodeDelaySec: number;
  turnEnd: TurnEndMode;
  // Name the tool in the notification text.
  details: boolean;
}

export const VSCODE_DELAYS = [0, 30, 120];
export const DEFAULT_PREFS: PushPrefs = { vscodeDelaySec: 30, turnEnd: "remote", details: false };

// GET /api/push/status: what the broker knows about one device's subscription.
export interface PushStatus {
  subscribed: boolean;
  device?: string;
  createdAt?: number;
  prefs?: PushPrefs;
  lastSent?: number;
  // status 0: the push service could not be reached.
  lastError?: { status: number; at: number };
}

// GET /api/push/badge: the number for the app icon of one device, and the sessions whose turn end it was told of and
// that have not been opened since.
export interface PushBadge {
  subscribed: boolean;
  badge: number;
  unseen: string[];
}

// What the service worker shows. badge: the app icon's number, when the notification carries one.
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  data: { url: string };
  badge?: number;
}
