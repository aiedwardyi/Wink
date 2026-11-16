import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { LIVE_VOICE, type LiveVoice } from "../../shared/live-call";
import { usePreview, VoiceGrid } from "./CallSettings";
import { Card } from "./SettingsPrimitives";

export function CallVoicePicker() {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const [failed, setFailed] = useState(false);
  // Bundled in public/, so nothing loads until the first tap and no key is needed.
  const { playing, preview } = usePreview(locale === "ko" ? "ko" : "en");
  const voice = state.config?.liveCall?.voice ?? LIVE_VOICE;

  const save = async (liveCall: { voice: LiveVoice }) => {
    setFailed(false);
    try {
      dispatch({ type: "configStatus", config: await api("/api/config", { method: "PUT", body: JSON.stringify({ liveCall }) }) });
    } catch {
      setFailed(true);
    }
  };

  return (
    <Card>
      <div data-settings-call-voice className="break-keep">
        <div className="text-[14px] font-medium text-ink">{t("callVoice.title")}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("callVoice.hint")}</div>
        <VoiceGrid label={t("callVoice.title")} value={voice} onPick={(name) => void save({ voice: name })} playing={playing} preview={preview} />
      </div>
      {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("callVoice.failed")}</p>}
    </Card>
  );
}
