import { useCallback, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { onThisPc } from "@/lib/devices-setup";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ConnectDevices } from "./ConnectDevices";
import { DeviceRow, DevicesGroup, YourPcs } from "./DeviceRows";
import { PhoneAccessSettings } from "./PhoneAccessSettings";
import { PhonePairing } from "./PhonePairing";
import { Fold } from "./Fold";
import { ROW_BUTTON } from "./SettingsPrimitives";

export function PhoneLinkSettings() {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [tailscaleOpen, setTailscaleOpen] = useState(false);
  const [paired, setPaired] = useState(0);
  const onPaired = useCallback(() => setPaired((count) => count + 1), []);
  const closePairing = useCallback(() => setPairOpen(false), []);
  const otherWays = useRef<HTMLElement>(null);
  // No relay on this PC: Connect from my devices opens the Tailscale QR here instead.
  const showOtherWays = useCallback(() => {
    setOthersOpen(true);
    setTailscaleOpen(true);
    otherWays.current?.scrollIntoView?.({ block: "start" });
  }, []);

  if (!onThisPc()) {
    return <div data-phone-settings className="rounded-xl bg-card p-4"><ConnectDevices /></div>;
  }

  return (
    <div data-phone-settings className="usage-sections">
      <PhoneAccessSettings refresh={paired} onEnabled={setOn} onNoRelay={showOtherWays} pcs={<YourPcs />} />
      <section ref={otherWays} data-other-ways="" className="min-w-0">
        <button type="button" aria-expanded={othersOpen} aria-controls="devices-other" onClick={() => setOthersOpen((open) => !open)}
          className="group flex items-center gap-2 text-[14px] font-semibold leading-5 text-ink">
          {t("settings.devices.otherWays")}
          <ChevronDown size={14} strokeWidth={2} aria-hidden="true" className={cn("-ml-0.5 shrink-0 text-ink-secondary transition-transform duration-150 ease-out group-hover:text-ink motion-reduce:transition-none", !othersOpen && "-rotate-90")} />
        </button>
        <Fold open={othersOpen} id="devices-other">
          <DevicesGroup label={t("settings.devices.otherWays")}>
            <DeviceRow name={t("settings.devices.codeInstead")} sub={t("settings.devices.codeInsteadHelp")}
              control={<button type="button" disabled={!on} aria-expanded={pairOpen} aria-controls="phone-pairing" onClick={() => setPairOpen((open) => !open)} className={ROW_BUTTON}>{t("settings.devices.getCode")}</button>}>
              <Fold open={pairOpen} id="phone-pairing">
                <div className="pt-3"><PhonePairing onPaired={onPaired} onClose={closePairing} /></div>
              </Fold>
            </DeviceRow>
            <DeviceRow name={t("settings.devices.tailscale")} sub={t("settings.devices.tailscaleHelp")}
              control={<button type="button" aria-expanded={tailscaleOpen} aria-controls="devices-tailscale" onClick={() => setTailscaleOpen((open) => !open)} className={ROW_BUTTON}>{t("settings.devices.setUp")}</button>} />
          </DevicesGroup>
          {/* Below the box: the store QRs need the full width at 360 px. */}
          <Fold open={tailscaleOpen} id="devices-tailscale">
            <div className="pt-3"><ConnectDevices /></div>
          </Fold>
        </Fold>
      </section>
    </div>
  );
}
