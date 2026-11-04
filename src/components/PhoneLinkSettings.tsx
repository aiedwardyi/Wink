import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { ConnectDevices } from "./ConnectDevices";
import { PhoneAccessSettings } from "./PhoneAccessSettings";
import { Fold } from "./Fold";

export function PhoneLinkSettings() {
  const { t } = useI18n();
  const [relayOpen, setRelayOpen] = useState(false);
  const [relayManaged, setRelayManaged] = useState(false);
  const relayBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return;
    let live = true;
    api("/api/phone-relay/status").then(() => live && setRelayManaged(true), () => {});
    return () => {
      live = false;
    };
  }, []);

  // The form renders once its status loads, so wait for it before focusing it. Scroll only
  // once its fold has opened too: mid-fold, the scroller cannot reach where the form ends up.
  useEffect(() => {
    const box = relayBox.current;
    if (!relayOpen || !box) return;
    const fold = box.closest("[data-fold]");
    let focused = false;
    const reveal = () => {
      if (!box.firstElementChild) return false;
      if (!focused) {
        focused = true;
        box.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
      }
      if (fold?.getAttribute("data-fold") === "opening") return false;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      box.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      return true;
    };
    if (reveal()) return;
    const watch = new MutationObserver(() => {
      if (reveal()) watch.disconnect();
    });
    watch.observe(box, { childList: true, subtree: true });
    if (fold) watch.observe(fold, { attributes: true, attributeFilter: ["data-fold"] });
    return () => watch.disconnect();
  }, [relayOpen]);

  return (
    <div data-phone-settings className="rounded-xl bg-card p-4">
      <ConnectDevices />
      {relayManaged && <>
        <button type="button" aria-expanded={relayOpen} aria-controls="phone-relay-settings" onClick={() => setRelayOpen((open) => !open)} className="mt-5 text-[12px] text-ink-secondary underline hover:text-ink">
          {t("settings.phone.relay")}
        </button>
        <Fold open={relayOpen} id="phone-relay-settings">
          <div ref={relayBox} className="mt-4 border-t border-hairline/40 pt-4"><PhoneAccessSettings /></div>
        </Fold>
      </>}
    </div>
  );
}
