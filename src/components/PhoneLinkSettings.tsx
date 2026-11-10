import { useCallback, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { ConnectDevices } from "./ConnectDevices";
import { YourPcs } from "./DeviceRows";
import { PhoneAccessSettings } from "./PhoneAccessSettings";
import { PhonePairing } from "./PhonePairing";
import { Fold } from "./Fold";

const link = "text-[12px] text-ink-secondary underline hover:text-ink";

export function PhoneLinkSettings() {
  const { t } = useI18n();
  const [pairOpen, setPairOpen] = useState(false);
  const [tailscaleOpen, setTailscaleOpen] = useState(false);
  const [paired, setPaired] = useState(0);
  const onPaired = useCallback(() => setPaired((count) => count + 1), []);
  const closePairing = useCallback(() => setPairOpen(false), []);

  // Relay management answers only on this PC; another device keeps the Tailscale page.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    return <div data-phone-settings className="rounded-xl bg-card p-4"><ConnectDevices /></div>;
  }

  return (
    <div data-phone-settings className="usage-sections">
      <PhoneAccessSettings refresh={paired} />
      <YourPcs />
      <div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <button type="button" aria-expanded={pairOpen} aria-controls="phone-pairing" onClick={() => setPairOpen((open) => !open)} className={link}>
            {t("settings.devices.pairWithCode")}
          </button>
          <button type="button" aria-expanded={tailscaleOpen} aria-controls="devices-tailscale" onClick={() => setTailscaleOpen((open) => !open)} className={link}>
            {t("settings.devices.useTailscale")}
          </button>
        </div>
        <Fold open={pairOpen} id="phone-pairing">
          <div className="pt-3"><PhonePairing onPaired={onPaired} onClose={closePairing} /></div>
        </Fold>
        <Fold open={tailscaleOpen} id="devices-tailscale">
          <div className="pt-3"><ConnectDevices /></div>
        </Fold>
      </div>
    </div>
  );
}
