import { useEffect, useRef } from "react";
import type { ServerMsg } from "../../../../broker/src/protocol.ts";
import { follower, unfollow } from "../../state.ts";

const POLL_MS = 2000;
// How soon the broker is asked again to follow after it could not, or after its watch ended.
const FOLLOW_RETRY_MS = 10_000;

type FollowMsg = Extract<ServerMsg, { t: "follow" }>;

// How the broker keeps a part of the page current: start asks it to follow under an id (true once it does), change
// takes what it sends.
export interface Follow {
  start: (id: string) => Promise<boolean>;
  change: (m: FollowMsg) => void;
}

// Reads once, then keeps the part current while `live` and the page is in front: from the changes the broker sends once
// it follows them, else by reading again every 2s, each read starting once the last one is over. When `live` ends it
// reads once more. `key` starts it over. Nothing is read while `on` is false; once it is true again it starts over. A
// read that fails (false) is not followed.
export function usePolling(read: () => Promise<boolean | void>, live: boolean, key: string, on = true, follow?: Follow): void {
  const fn = useRef(read);
  fn.current = read;
  const via = useRef(follow);
  via.current = follow;
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let busy = false;
    let timer: number | undefined;
    let following: { id: string; off: () => void } | undefined;
    let asked = 0;
    const front = () => document.visibilityState === "visible";
    const later = () => {
      clearTimeout(timer);
      if (!stopped && live && front() && !following) timer = window.setTimeout(tick, POLL_MS);
    };
    const letGo = () => {
      if (!following) return;
      following.off();
      unfollow(following.id);
      following = undefined;
      asked = 0;
    };
    const ask = async (): Promise<boolean> => {
      const f = via.current;
      if (!f || Date.now() - asked < FOLLOW_RETRY_MS) return false;
      asked = Date.now();
      const mine = follower({
        change: (m) => via.current?.change(m),
        end: () => {
          if (following !== mine) return;
          following = undefined;
          later();
        },
      });
      following = mine;
      const ok = await f.start(mine.id).catch(() => false);
      if (following !== mine) return false;
      if (ok) return true;
      unfollow(mine.id);
      following = undefined;
      return false;
    };
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || busy || following) return;
      busy = true;
      let ok: boolean | void;
      try {
        ok = await fn.current();
      } finally {
        busy = false;
      }
      if (stopped || !live || !front() || following) return;
      if (ok !== false && (await ask())) return;
      later();
    };
    const onVisible = () => {
      if (front()) void tick();
      else {
        letGo();
        clearTimeout(timer);
      }
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      letGo();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, key, on]);
}
