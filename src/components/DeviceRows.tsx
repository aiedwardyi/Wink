import { useState, type ReactNode } from "react";

import { leaveFor } from "@/lib/back-navigation";
import { useI18n } from "@/lib/i18n";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { StepMark } from "./DeviceSetupParts";
import { useDevices } from "./DeviceSwitcher";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { AccountGroup } from "./UsageDesk";

export function DevicesSection({ title, after, children, ...data }: { title: string; after?: ReactNode; children: ReactNode; [data: `data-${string}`]: string }) {
  const terminal = isTerminalSkin(useSkin());
  return (
    <section {...data} className="min-w-0">
      <h3 className="text-[14px] font-semibold leading-5 text-ink">{title}</h3>
      <AccountGroup label={title} terminal={terminal}>{children}</AccountGroup>
      {after}
    </section>
  );
}

/** A Usage row: name, one grey line, one right slot. `ready` labels the green check before the control. */
export function DeviceRow({ name, sub, control, ready }: { name: string; sub?: string; control?: ReactNode; ready?: string }) {
  return (
    <div data-account-row="" className="min-w-0 border-hairline/70 [&+&]:border-t">
      <div className="usage-account-head">
        <div className="usage-account-identity min-w-0">
          <span className="min-w-0 break-words">{name}</span>
          {sub && <span className="usage-email">{sub}</span>}
        </div>
        {(control || ready) && <div className="usage-control flex h-[22px] items-center gap-2">
          {ready && <StepMark done step={0} label={ready} />}
          {control}
        </div>}
      </div>
    </div>
  );
}

/** The picker's PCs. */
export function YourPcs() {
  const { t } = useI18n();
  const [devices, reload] = useDevices(true);
  const [opening, setOpening] = useState<string | null>(null);
  if (!devices.length) return null;
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
      {devices.map((device) => {
        const online = !device.offline && !device.checking;
        const sub = device.current ? t("chrome.deviceCurrent") : device.checking ? t("chrome.deviceChecking") : device.offline ? t("chrome.deviceOffline") : t("settings.devices.online");
        return <DeviceRow key={device.deviceId} name={device.name} sub={sub} ready={online ? t("settings.devices.online") : undefined}
          control={online && !device.current ? <button type="button" disabled={opening === device.host} onClick={() => open(device.host, device.name)} className={ROW_BUTTON}>{t("settings.devices.openButton")}</button> : null} />;
      })}
    </DevicesSection>
  );
}
