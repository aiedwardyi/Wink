import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";

interface Pairing {
  url: string;
  code: string;
  expiresAt: number;
  /** Phones paired before this code, so a new one can be noticed. */
  known: string[];
}

const PAIRING_POLL_MS = 2_000;
const button = "rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70 disabled:cursor-not-allowed disabled:opacity-50";

function countdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A 6-digit code and QR for a phone without Google. Makes its first code on mount. */
export function PhonePairing({ request = api, onPaired, onClose }: { request?: typeof api; onPaired: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const loadPhones = useCallback(() => request("/api/phone/devices").then((body: { phones: { id: string; name: string }[] }) => body.phones), [request]);

  const make = useCallback(async () => {
    setBusy(true);
    setError(false);
    try {
      const known = (await loadPhones()).map((phone) => phone.id);
      const body: Omit<Pairing, "known"> = await request("/api/phone/pairing", { method: "POST" });
      if (!live.current) return;
      setPaired(null);
      setNow(Date.now());
      setPairing({ ...body, known });
    } catch {
      if (live.current) setError(true);
    } finally {
      if (live.current) setBusy(false);
    }
  }, [loadPhones, request]);

  useEffect(() => {
    live.current = true;
    void make();
    return () => {
      live.current = false;
    };
  }, [make]);

  // While a code is up: tick its countdown and notice the phone that used it.
  useEffect(() => {
    if (!pairing) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const poll = window.setInterval(() => {
      void loadPhones()
        .then((list) => {
          const added = list.find((phone) => !pairing.known.includes(phone.id));
          if (!added || !live.current) return;
          setPairing(null);
          setPaired(added.name);
          onPaired();
        })
        .catch(() => {});
    }, PAIRING_POLL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [pairing, loadPhones, onPaired]);

  useEffect(() => {
    if (pairing) qrRef.current?.scrollIntoView({ block: "nearest" });
  }, [pairing]);

  const cancel = () => {
    if (pairing) void request("/api/phone/pairing", { method: "DELETE" }).catch(() => {});
    setPairing(null);
    onClose();
  };
  const left = pairing ? Math.max(0, pairing.expiresAt - now) : 0;

  return (
    <div data-phone-pairing ref={qrRef} className="flex flex-col items-center rounded-xl bg-inset px-4 py-4 text-center">
      {paired ? (
        <p className="text-[12.5px] text-success">{t("settings.phoneAccess.paired", { name: paired })}</p>
      ) : error ? (
        <p role="alert" className="text-[12.5px] text-danger">{t("settings.phoneAccess.pairError")}</p>
      ) : pairing && left > 0 ? (
        <>
          <div className="rounded-2xl bg-white p-3" aria-label={t("settings.phoneAccess.qrLabel")}>
            <QRCodeSVG value={pairing.url} size={168} level="M" bgColor="#ffffff" fgColor="#111111" />
          </div>
          <div data-pairing-code className="mt-3 font-mono text-[22px] tracking-[0.25em] text-ink">
            {pairing.code}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("settings.phoneAccess.scan")}</p>
          <p className="mt-1 text-[11.5px] text-ink-secondary">{t("settings.phoneAccess.expiresIn", { time: countdown(left) })}</p>
        </>
      ) : pairing ? (
        <p className="text-[13px] text-ink-secondary">{t("settings.phoneAccess.expired")}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        {(error || (pairing && left <= 0) || paired) && (
          <button type="button" disabled={busy} onClick={() => void make()} className={button}>
            {t("settings.phoneAccess.newCode")}
          </button>
        )}
        <button type="button" onClick={cancel} className={button}>
          {t("settings.phoneAccess.cancel")}
        </button>
      </div>
    </div>
  );
}
