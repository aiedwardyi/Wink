import { useState, type ReactNode } from "react";

import { leaveFor } from "@/lib/back-navigation";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { StepMark } from "./DeviceSetupParts";
import { useDevices } from "./DeviceSwitcher";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { AccountGroup } from "./UsageDesk";

const OPEN_BUTTON = cn(ROW_BUTTON, "border-transparent bg-accent font-medium text-accent-ink not-disabled:hover:bg-accent not-disabled:hover:brightness-110 focus-visible:bg-accent");

export function DevicesGroup({ label, children }: { label: string; children: ReactNode }) {
  return <AccountGroup label={label} terminal={isTerminalSkin(useSkin())}>{children}</AccountGroup>;
}

export function DevicesSection({ title, after, children, ...data }: { title: string; after?: ReactNode; children: ReactNode; [data: `data-${string}`]: string }) {
  return (
    <section {...data} className="min-w-0">
      <h3 className="text-[14px] font-semibold leading-5 text-ink">{title}</h3>
      <DevicesGroup label={title}>{children}</DevicesGroup>
      {after}
    </section>
  );
}

/** A Usage row: name, one grey line, one right slot. `ready` labels the green check before the name; `children` open under the row. */
export function DeviceRow({ name, sub, control, ready, children }: { name: string; sub?: string; control?: ReactNode; ready?: string; children?: ReactNode }) {
  return (
    <div data-account-row="" className="min-w-0 border-hairline/70 [&+&]:border-t">
      <div className="usage-account-head">
        <div className="usage-account-identity min-w-0">
          <span data-device-name="" className={cn("min-w-0 break-words", ready && "flex gap-1.5")}>
            {ready ? <>
              <span className="flex h-[22px] shrink-0 items-center"><StepMark done step={0} label={ready} /></span>
              <span className="min-w-0">{name}</span>
            </> : name}
          </span>
          {/* .usage-email is unlayered CSS, so only an inline style lets the help lines wrap. */}
          {sub && <span className="usage-email" style={{ whiteSpace: "normal" }}>{sub}</span>}
        </div>
        {control && <div className="usage-control flex h-[22px] items-center">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/** A blank row the height of a device row, held until a list first answers. */
export const PendingRow = ({ sub }: { sub?: boolean }) => <DeviceRow name={"\u00a0"} sub={sub ? "\u00a0" : undefined} control={<span />} />;

/** The picker's other PCs; this one leads the page as This PC. */
export function YourPcs() {
  const { t } = useI18n();
  const [devices, reload, known] = useDevices(true, true, true);
  const [opening, setOpening] = useState<string | null>(null);
  const others = devices.filter((device) => !device.current);
  if (!known) return <DevicesSection title={t("chrome.devices")} data-your-pcs=""><PendingRow /></DevicesSection>;
  if (!others.length) return null;
  const deviceWindow = window.ogb?.deviceWindow;
  const open = (host: string, name: string) => {
    if (!deviceWindow) return leaveFor(`https://${host}/`);
    setOpening(host);
    void deviceWindow.open(host, name).then((opened) => {
      if (!opened) void reload();
    }, () => void reload()).finally(() => setOpening(null));
  };
  return (
    <DevicesSection title={t("chrome.devices")} data-your-pcs="">
      {others.map((device) => {
        const online = !device.offline && !device.checking;
        const sub = device.checking ? t("chrome.deviceChecking") : device.offline ? t("chrome.deviceOffline") : undefined;
        return <DeviceRow key={device.deviceId} name={device.name} sub={sub} ready={online ? t("settings.devices.online") : undefined}
          control={online ? <button type="button" disabled={opening === device.host} onClick={() => open(device.host, device.name)} className={OPEN_BUTTON}>{t("settings.devices.openButton")}</button> : null} />;
      })}
    </DevicesSection>
  );
}
