import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { lazyView } from "@/lib/stale-build";
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
const slots = new Map<symbol, { hidden: boolean; last?: string }>();
const owner = () => [...slots].find(([, slot]) => !slot.hidden)?.[0];
const listeners = new Set<() => void>();
const notify = () => {
  const at = owner();
  if (release && anchor === undefined && at) {
    anchor = slots.get(at)!.last ?? null;
    if (anchor) void api("/api/whats-new/anchor", { method: "POST", body: JSON.stringify({ release, id: anchor }) }).catch(() => {});
  }
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useWhatsNewAnchor = () => useSyncExternalStore(subscribe, () => anchor, () => undefined);

export function WhatsNewSlot({ hidden = false, last }: { hidden?: boolean; last?: string }) {
  const { state } = useStore();
  const [me] = useState(() => Symbol());
  useEffect(() => () => {
    slots.delete(me);
    notify();
  }, [me]);
  useEffect(() => {
    slots.set(me, { hidden, last });
    notify();
  }, [me, hidden, last]);
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
        release = next.release;
        anchor = next.anchor;
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
