import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { lazyView } from "@/lib/stale-build";
import { usePresence } from "@/lib/use-presence";
import { api, useStore } from "@/state/store";
import { LazyView } from "./LazyView";

const WhatsNewCard = lazyView(() => import("./WhatsNewCard"));

// Off the startup path: asked once per app session, well after the first paint.
const ASK_AFTER_MS = 1500;
let asked: Promise<string | null> | undefined;
// Every mounted chat has a slot; only the first one shows the card, and closing it closes it everywhere.
let release: string | null = null;
const slots: symbol[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function WhatsNewSlot() {
  const { state } = useStore();
  const [me] = useState(() => Symbol());
  useEffect(() => {
    slots.push(me);
    notify();
    return () => {
      slots.splice(slots.indexOf(me), 1);
      notify();
    };
  }, [me]);
  const mine = useSyncExternalStore(subscribe, () => (slots[0] === me ? release : null), () => null);
  const shown = usePresence(mine);
  useEffect(() => {
    if (!state.hydrated) return;
    const timer = setTimeout(() => {
      const ask = (asked ??= api("/api/whats-new").then((body: { release?: string | null }) => body.release ?? null, () => null));
      void ask.then((next) => {
        if (asked !== ask || release === next) return;
        release = next;
        notify();
      });
    }, ASK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state.hydrated]);
  const close = useCallback(() => {
    asked = Promise.resolve(null);
    release = null;
    notify();
  }, []);
  if (!shown.mounted || !shown.value) return null;
  return (
    <LazyView>
      <WhatsNewCard release={shown.value} closing={shown.closing} onClose={close} />
    </LazyView>
  );
}
