import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { LIVE_LANGUAGES, LIVE_VOICE, LIVE_VOICES, type LiveLanguage, type LiveVoice } from "../../shared/live-call";
import { SegmentedRow } from "./Segmented";
import { Card } from "./SettingsPrimitives";

export function CallVoicePicker() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [failed, setFailed] = useState(false);
  const voice = state.config?.liveCall?.voice ?? LIVE_VOICE;
  const language = state.config?.liveCall?.language ?? "auto";

  const save = async (liveCall: { voice: LiveVoice } | { language: LiveLanguage }) => {
    setFailed(false);
    try {
      dispatch({ type: "configStatus", config: await api("/api/config", { method: "PUT", body: JSON.stringify({ liveCall }) }) });
    } catch {
      setFailed(true);
    }
  };

  return (
    <Card>
      <div data-settings-call-voice className="divide-y divide-hairline/40">
        <div className="pb-4">
          <SegmentedRow<LiveVoice>
            label={t("callVoice.title")}
            hint={t("callVoice.hint")}
            value={voice}
            options={LIVE_VOICES.map((id) => ({ id, label: t(`callVoice.${id}`) }))}
            onChange={(id) => void save({ voice: id })}
          />
        </div>
        <div className="pt-4">
          <SegmentedRow<LiveLanguage>
            label={t("callVoice.language")}
            hint={t("callVoice.languageHint")}
            value={language}
            options={LIVE_LANGUAGES.map((id) => ({ id, label: id === "auto" ? t("callVoice.auto") : t(`language.name.${id}`) }))}
            onChange={(id) => void save({ language: id })}
          />
        </div>
      </div>
      {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("callVoice.failed")}</p>}
    </Card>
  );
}
