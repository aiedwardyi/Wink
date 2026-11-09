import { useCallback, useEffect, useState } from "react";
import { lazyView } from "@/lib/stale-build";
import { usePresence } from "@/lib/use-presence";
import { api, useStore } from "@/state/store";
import { LazyView } from "./LazyView";

const WhatsNewCard = lazyView(() => import("./WhatsNewCard"));

// Off the startup path: asked once per app session, well after the first paint.
const ASK_AFTER_MS = 1500;
let asked: Promise<string | null> | undefined;

export function WhatsNewSlot() {
  const { state } = useStore();
  const [release, setRelease] = useState<string | null>(null);
  const shown = usePresence(release);
  useEffect(() => {
    if (!state.hydrated) return;
    let alive = true;
    const timer = setTimeout(() => {
      asked ??= api("/api/whats-new").then((body: { release?: string | null }) => body.release ?? null, () => null);
      void asked.then((next) => alive && setRelease(next));
    }, ASK_AFTER_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [state.hydrated]);
  const close = useCallback(() => {
    asked = Promise.resolve(null);
    setRelease(null);
  }, []);
  if (!shown.mounted || !shown.value) return null;
  return (
    <LazyView>
      <WhatsNewCard release={shown.value} closing={shown.closing} onClose={close} />
    </LazyView>
  );
}
