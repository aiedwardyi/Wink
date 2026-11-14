import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { lazyView } from "@/lib/stale-build";
import { CATCHING_UP_POLL_MS } from "@/lib/use-catching-up";
import { usePresence } from "@/lib/use-presence";
import { api, useStore } from "@/state/store";
import { LazyView } from "./LazyView";

const WhatsNewCard = lazyView(() => import("./WhatsNewCard"));

// Off the startup path: asked once per app session, well after the first paint.
const ASK_AFTER_MS = 1500;
let asked: Promise<{ release: string; anchor?: string } | null> | undefined;
// Every mounted chat has a slot; only the first visible one shows the card, and closing it closes it everywhere.
let release: string | null = null;
// The message the card sits after; null keeps it at the bottom of an empty chat.
let anchor: string | null | undefined;
// Fresh notes wait here while the visible chat still pulls what another PC wrote, so the card lands under all of it.
let held: string | null = null;
let checking = false;
let recheck: ReturnType<typeof setTimeout> | undefined;
// An offline PC never lists Drive, so "not listed yet" holds the notes only this long.
const UNLISTED_MS = 60_000;
let unlisted = 0;
const slots = new Map<symbol, { hidden: boolean; last?: string; thread?: string }>();
const owner = () => [...slots].find(([, slot]) => !slot.hidden)?.[0];
const listeners = new Set<() => void>();
const notify = () => {
  const at = owner();
  if (release && anchor === undefined && at) {
    anchor = slots.get(at)!.last ?? null;
    if (anchor) void api("/api/whats-new/anchor", { method: "POST", body: JSON.stringify({ release, id: anchor }) }).catch(() => {});
  }
  listeners.forEach((listener) => listener());
  settle();
};
function settle() {
  const at = owner();
  if (!held || !at || checking || recheck) return;
  const show = () => {
    release = held;
    held = null;
    notify();
  };
  const thread = slots.get(at)!.thread;
  if (!thread) return show();
  checking = true;
  void api(`/api/catching-up/${encodeURIComponent(thread)}`)
    .then((body: { catchingUp: boolean | null }) => body.catchingUp ?? (unlisted += CATCHING_UP_POLL_MS) < UNLISTED_MS, () => false)
    .then((pulling) => {
      checking = false;
      const now = owner();
      // a chat opened while this was asked gets its own answer
      if (!pulling && now && slots.get(now)!.thread === thread) return show();
      recheck = setTimeout(() => {
        recheck = undefined;
        settle();
      }, CATCHING_UP_POLL_MS);
    });
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useWhatsNewAnchor = () => useSyncExternalStore(subscribe, () => anchor, () => undefined);

export function WhatsNewSlot({ hidden = false, last, thread }: { hidden?: boolean; last?: string; thread?: string }) {
  const { state } = useStore();
  const [me] = useState(() => Symbol());
  useEffect(() => () => {
    slots.delete(me);
    notify();
  }, [me]);
  useEffect(() => {
    slots.set(me, { hidden, last, thread });
    notify();
  }, [me, hidden, last, thread]);
  const mine = useSyncExternalStore(subscribe, () => (owner() === me ? release : null), () => null);
  const shown = usePresence(mine);
  useEffect(() => {
    if (!state.hydrated) return;
    const timer = setTimeout(() => {
      // The notes stay out of the startup bundle: they load only when an update may have some to show.
      const ask = (asked ??= api("/api/whats-new")
        .then(async (body: { release?: string | null; seen?: string | null; anchor?: { release: string; id: string } }) => {
          const shown = body.release ? (await import("@/lib/whats-new")).unseenRelease(body.release, body.seen ?? null) : null;
          return shown ? { release: shown, anchor: body.anchor?.release === shown ? body.anchor.id : undefined } : null;
        })
        .catch(() => null));
      void ask.then((next) => {
        if (asked !== ask || !next || release === next.release) return;
        anchor = next.anchor;
        // notes already placed keep their place; only a first showing waits
        if (next.anchor === undefined) held = next.release;
        else release = next.release;
        notify();
      });
    }, ASK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state.hydrated]);
  const close = useCallback(() => {
    if (release) void api("/api/whats-new/seen", { method: "POST", body: JSON.stringify({ release }) }).catch(() => {});
    asked = Promise.resolve(null);
    release = null;
    anchor = undefined;
    notify();
  }, []);
  if (!shown.mounted || !shown.value || (!mine && release)) return null;
  return (
    <LazyView>
      <WhatsNewCard release={shown.value} closing={shown.closing} onClose={close} />
    </LazyView>
  );
}
