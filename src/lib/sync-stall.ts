import { useEffect } from "react";

import { activeLocale, localeTag, translate, type LocaleId, type MessageKey } from "@/lib/i18n";
import { showNotification, type NotifyFrame } from "@/lib/notify";
import { api } from "@/state/store";

export type DeviceStall = { since: number; reason: "held" | "error" };
type StuckDevice = { deviceId: string; name: string; current: boolean; stuck?: DeviceStall };

const POLL_MS = 60_000;
// Per stall for this run; a restart may say it once more.
const told = new Set<string>();

/** When a PC stopped syncing, in the viewer's time; with the date when not today. */
export function stallTime(since: number, locale: LocaleId, now = Date.now()): string {
  const at = new Date(since);
  const time = { hour: "numeric", minute: "2-digit" } as const;
  return at.toLocaleString(localeTag(locale), at.toDateString() === new Date(now).toDateString() ? time : { month: "short", day: "numeric", ...time });
}

export function stallNotice(device: StuckDevice, stuck: DeviceStall, locale: LocaleId, now = Date.now()): NotifyFrame {
  const t = (key: MessageKey, vars?: Record<string, string>) => translate(locale, key, vars);
  const body = stuck.reason === "held"
    ? t(device.current ? "chrome.deviceStuckHeldHere" : "chrome.deviceStuckHeld")
    : device.current ? t("chrome.deviceStuckErrorHere", { place: `${t("settings.title")} → ${t("settings.section.sync")}` }) : t("chrome.deviceStuckError");
  return {
    kind: "takeover",
    botId: "sync",
    botName: device.name,
    // No chat shows this id, so the toast shows even while Wink is focused.
    threadId: `sync-stall:${device.deviceId}`,
    title: t("chrome.deviceStuckTitle", { name: device.name, time: stallTime(stuck.since, locale, now) }),
    body,
    icon: "",
  };
}

export function noticeStalls(devices: StuckDevice[], locale: LocaleId): void {
  for (const device of devices) {
    const { stuck } = device;
    if (!stuck || told.has(`${device.deviceId}:${stuck.since}`)) continue;
    told.add(`${device.deviceId}:${stuck.since}`);
    showNotification(stallNotice(device, stuck, locale), () => {}, null);
  }
}

/** Desktop app only: one toast per PC that stopped syncing, this one included. */
export function useSyncStalls(): void {
  useEffect(() => {
    if (!window.ogb) return;
    const check = () => {
      api("/api/devices")
        .then((body: { devices: StuckDevice[] }) => noticeStalls(body.devices, activeLocale()))
        .catch(() => {});
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
}
