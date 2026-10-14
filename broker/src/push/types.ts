// Shapes the web client shares with the broker's push notifications.

// Notification settings of one subscribed device.
export interface PushPrefs {
  // VS Code sessions: seconds a request waits first, so an answer at the laptop does not buzz the phone.
  vscodeDelaySec: number;
  // Notify when a turn ends on a session the remote user sent to.
  turnDone: boolean;
  // Name the tool in the notification text.
  details: boolean;
}

export const VSCODE_DELAYS = [0, 30, 120];
export const DEFAULT_PREFS: PushPrefs = { vscodeDelaySec: 30, turnDone: true, details: false };

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

// What the service worker shows.
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  data: { url: string };
}
