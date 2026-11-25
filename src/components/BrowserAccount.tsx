import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { leaveSignedOut, sessionState, sessionStreamLive, signedOutLanding } from "@/lib/signed-out";
import { api, useStore } from "@/state/store";
import { AccountRow } from "./AccountRow";

/** A relay browser's account: the PC's Google email, since every session here is the owner's, and Sign Out. */
export function BrowserAccount({ site, className }: { site: string; className?: string }) {
  const { t } = useI18n();
  const { reconnectLive } = useStore();
  const signingOut = useRef(false);
  const [email, setEmail] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let gone = false;
    api("/api/google-account").then((account) => {
      if (!gone) setEmail(account?.email ? String(account.email) : "");
    }, () => {});
    return () => {
      gone = true;
    };
  }, []);

  const signOut = async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setFailed(false);
    signedOutLanding(`${site}/?signedout=1`);
    const confirmation = new AbortController();
    try {
      await api("/api/phone/sign-out", { method: "POST" });
      return leaveSignedOut(true);
    } catch {
      const live = sessionStreamLive(confirmation.signal);
      const probe = new AbortController();
      const state = await Promise.race([sessionState(probe), live]);
      probe.abort();
      if (state === "gone") return leaveSignedOut();
      if (state === "unknown") {
        // The old stream can outlive a revoke or a gateway outage on new requests.
        reconnectLive();
        await live;
      }
      signedOutLanding();
      setFailed(true);
    } finally {
      confirmation.abort();
      signingOut.current = false;
    }
  };

  return (
    <AccountRow
      email={email}
      actions={[{ label: t("chrome.signOut"), run: () => void signOut() }]}
      error={failed ? t("chrome.signOutFailed") : undefined}
      className={className}
    />
  );
}
