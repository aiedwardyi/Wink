import type { MouseEvent } from "react";
import { Check } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";

const APP_STORE = "https://apps.apple.com/us/app/tailscale/id1470499037";
const GOOGLE_PLAY = "https://play.google.com/store/apps/details?id=com.tailscale.ipn";
export const button = "inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover";
const quietLink = "text-[12px] text-ink-secondary underline hover:text-ink";

function tailscaleDownload(): string {
  const platform = window.ogb?.platform;
  if (platform === "win32") return "https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe";
  if (platform === "darwin") return "https://tailscale.com/download/mac";
  return "https://tailscale.com/download";
}

export function openOutside(event: MouseEvent, url: string) {
  if (!window.ogb?.openExternal) return;
  event.preventDefault();
  void window.ogb.openExternal(url).catch(() => {});
}

export function StepMark({ done, step, label, muted }: { done: boolean; step: number; label: string; muted?: boolean }) {
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[13px]", done ? "bg-success/15 text-success" : muted ? "bg-control/50 text-ink-secondary" : "bg-control text-ink")}>
      {done ? <Check key="done" size={15} aria-label={label} className="animate-pop-in" /> : step}
    </span>
  );
}

export function GetTailscaleLink({ primary, onOpen }: { primary?: boolean; onOpen?: () => void }) {
  const { t } = useI18n();
  const url = tailscaleDownload();
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={(event) => { openOutside(event, url); onOpen?.(); }} className={primary ? `${button} mt-2` : quietLink}>
      {t("settings.phone.getTailscale")}
    </a>
  );
}

export function StoreCodes({ phone }: { phone: boolean }) {
  const { t } = useI18n();
  const stores = [
    { url: APP_STORE, label: t("settings.devices.iphone"), store: t("settings.devices.appStore") },
    { url: GOOGLE_PLAY, label: t("settings.devices.android"), store: t("settings.devices.googlePlay") },
  ];
  if (phone) {
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        {stores.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className={button}>{s.store}</a>)}
      </div>
    );
  }
  return (
    <div data-store-codes className="animate-fade-in mt-2 flex gap-3">
      {stores.map((s) => (
        <figure key={s.url} className="m-0 flex flex-col items-center gap-1.5">
          <div className="rounded-xl bg-white p-2.5"><QRCodeSVG value={s.url} size={104} level="M" bgColor="#ffffff" fgColor="#111111" /></div>
          <figcaption className="text-[12px] text-ink-secondary">{s.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function StoreLinks() {
  const { t } = useI18n();
  return (
    <span className="flex gap-3">
      <a href={APP_STORE} target="_blank" rel="noreferrer" onClick={(event) => openOutside(event, APP_STORE)} className={quietLink}>{t("settings.devices.appStore")}</a>
      <a href={GOOGLE_PLAY} target="_blank" rel="noreferrer" onClick={(event) => openOutside(event, GOOGLE_PLAY)} className={quietLink}>{t("settings.devices.googlePlay")}</a>
    </span>
  );
}
