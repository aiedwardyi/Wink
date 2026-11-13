import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { useActiveCall } from "@/lib/live-call/active";
import { api, useStore } from "@/state/store";
import { LIVE_LANGUAGES, LIVE_VOICE, LIVE_VOICES, type LiveLanguage, type LiveVoice } from "../../shared/live-call";
import { SegmentedRow } from "./Segmented";
import { Card } from "./SettingsPrimitives";

const PILL = "rounded-[max(0px,calc(var(--radius-lg)_-_3px))]";

export function CallVoicePicker() {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const onCall = Boolean(useActiveCall());
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState<LiveVoice | null>(null);
  const clip = useRef<HTMLAudioElement | null>(null);
  const voice = state.config?.liveCall?.voice ?? LIVE_VOICE;
  const language = state.config?.liveCall?.language ?? "auto";

  const stop = () => {
    clip.current?.pause();
    clip.current = null;
    setPlaying(null);
  };
  useEffect(() => (onCall ? stop() : undefined), [onCall]);
  useEffect(() => () => clip.current?.pause(), []);

  const preview = (name: LiveVoice) => {
    const was = playing;
    stop();
    if (was === name) return;
    // Bundled in public/, so nothing loads until the first tap and no key is needed.
    const audio = new Audio(`/voice-preview/${name}-${language === "auto" ? (locale === "ko" ? "ko" : "en") : language}.mp3`);
    audio.onended = () => clip.current === audio && stop();
    clip.current = audio;
    setPlaying(name);
    audio.play().catch(() => clip.current === audio && stop());
  };

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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-4">
          <div className="min-w-[min(100%,12rem)] flex-1 break-keep">
            <div className="text-[14px] font-medium text-ink">{t("callVoice.title")}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("callVoice.hint")}</div>
          </div>
          <div role="radiogroup" aria-label={t("callVoice.title")} className="ml-auto flex w-fit shrink-0 gap-0.5 rounded-lg bg-inset p-[3px]">
            {LIVE_VOICES.map((id) => [id, t(`callVoice.${id}`)] as const).map(([name, label]) => (
              <div key={name} className={cn("flex items-center", PILL, name === voice && "bg-raised shadow-sm ring-1 ring-hairline/60")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={name === voice}
                  onClick={() => void save({ voice: name })}
                  className={cn(
                    "px-2 py-1 text-[12.5px] font-medium",
                    PILL,
                    !onCall && "pr-1",
                    name === voice ? "text-ink" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {label}
                </button>
                {!onCall && (
                  <button
                    type="button"
                    aria-label={t(playing === name ? "callVoice.stop" : "callVoice.play", { name: label })}
                    aria-pressed={playing === name}
                    onClick={() => preview(name)}
                    className="mr-0.5 grid size-6 place-items-center rounded-full text-ink-secondary hover:text-ink max-md:size-8"
                  >
                    {playing === name ? <Square size={9} aria-hidden className="fill-current" /> : <Play size={10} aria-hidden className="fill-current" />}
                  </button>
                )}
              </div>
            ))}
          </div>
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
