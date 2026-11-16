import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Pause, Play } from "lucide-react";

import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { voiceLabel } from "@/lib/live-call/voice-label";
import { CALL_VOLUME, setCallVolume, useCallVolume } from "@/lib/live-call/volume";
import { hapticTick } from "@/lib/phone-swipe";
import { markCut } from "@/lib/scroll-cut";
import { useBackLayer } from "@/lib/use-back-layer";
import { guardMenuTouch, useListMenuDismiss } from "@/lib/use-hold-menu";
import { usePresence } from "@/lib/use-presence";
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from "@/lib/use-touch-drag";
import { CALL_SPEED, CALL_STYLES, LIVE_VOICE, LIVE_VOICES, type CallPrefs, type LiveVoice } from "../../shared/live-call";
import { BotAvatar } from "./Avatar";
import { DETAILS_BOX, DETAILS_ROW } from "./BotDetailsRows";
import { Fold } from "./Fold";
import { MENU_CLASS } from "./MessageMenu";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { AccountPicker } from "./UsageAccounts";

const LABEL = "shrink-0 text-[14px] text-ink";
const PILL = "rounded-[max(0px,calc(var(--radius-lg)_-_3px))]";
const SLIDER = cn(
  "h-8 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent focus-visible:outline-none",
  "[&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-accent)_var(--fill),color-mix(in_srgb,var(--color-ink)_14%,transparent)_var(--fill))]",
  "[&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-focus",
  "[&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-ink/15 [&::-moz-range-progress]:h-2 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-accent [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white",
);
const LANGUAGES = [{ id: "en", name: "English" }, { id: "ko", name: "한국어" }] as const;

function useCallPrefs(bot: Bot) {
  const { state, dispatch } = useStore();
  const call = (state.bots.find((b) => b.id === bot.id) ?? bot).call;
  return {
    voice: call?.voice ?? state.config?.liveCall?.voice ?? LIVE_VOICE,
    speed: call?.speed ?? 1,
    style: call?.style ?? "normal",
    language: call?.language,
    set: (change: CallPrefs) => dispatch({ type: "updateBot", botId: bot.id, patch: { call: { ...call, ...change } } }),
  };
}

export function usePreview(language: "en" | "ko") {
  const [playing, setPlaying] = useState<LiveVoice | null>(null);
  const clip = useRef<HTMLAudioElement | null>(null);
  const stop = () => {
    clip.current?.pause();
    clip.current = null;
    setPlaying(null);
  };
  useEffect(() => () => clip.current?.pause(), []);
  const volume = useCallVolume();
  useEffect(() => {
    if (clip.current) clip.current.volume = volume;
  }, [volume]);
  const preview = (name: LiveVoice) => {
    const was = playing;
    stop();
    if (was === name) return;
    const audio = new Audio(`/voice-preview/${name}-${language}.mp3`);
    audio.volume = volume;
    audio.onended = () => clip.current === audio && stop();
    clip.current = audio;
    setPlaying(name);
    audio.play().catch(() => clip.current === audio && stop());
  };
  return { playing, preview };
}

function Slider({ label, value, range, text, onChange }: {
  label: string;
  value: number;
  range: { min: number; max: number; step: number };
  text: string;
  onChange: (value: number) => void;
}) {
  const fill = ((value - range.min) / (range.max - range.min)) * 100;
  return (
    <div className="flex items-center gap-3">
      <span className={cn(LABEL, "w-14")}>{label}</span>
      <input type="range" aria-label={label} aria-valuetext={text} min={range.min} max={range.max} step={range.step} value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={SLIDER} style={{ "--fill": `${fill}%` } as CSSProperties} />
      <span className="w-10 shrink-0 text-right text-[13px] tabular-nums text-ink">{text}</span>
    </div>
  );
}

function CallLanguage({ bot }: { bot: Bot }) {
  const { t } = useI18n();
  const { language, set } = useCallPrefs(bot);
  return (
    <AccountPicker field label={t("callMenu.language")} viewedId={language ?? ""}
      select={(id) => set({ language: id === "en" || id === "ko" ? id : undefined })}
      className="shrink-0" triggerClassName="w-auto gap-1.5 rounded-full bg-transparent px-3 py-1 text-[13px] ring-1 ring-hairline max-md:min-h-8"
      accounts={[{ id: "", name: t("callMenu.auto") }, ...LANGUAGES]} />
  );
}

/** Every voice as a card with its vibe and a preview; three rows show, and the cut-off fourth row and fade say the rest scroll. */
export function VoiceGrid({ label, value, onPick, playing, preview, badge }: {
  label?: string;
  value: LiveVoice;
  onPick: (voice: LiveVoice) => void;
  playing: LiveVoice | null;
  preview: (voice: LiveVoice) => void;
  badge?: ReactNode;
}) {
  const { t } = useI18n();
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    markCut(el);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => markCut(el));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <div ref={grid} role="radiogroup" aria-label={label ?? t("callMenu.voice")} data-call-voices="" onScroll={(event) => markCut(event.currentTarget)}
      className="-mx-1 mt-1 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto overscroll-contain p-1 data-[cut]:[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]">
      {LIVE_VOICES.map((id) => {
        const shown = voiceLabel(t, id);
        const picked = id === value;
        return (
          <div key={id} data-call-voice={id} className={cn("relative rounded-xl ring-1", picked ? "bg-raised-hover ring-ink-secondary/40" : "ring-hairline hover:bg-raised-hover/50")}>
            <button type="button" role="radio" aria-checked={picked} onClick={() => onPick(id)}
              className="flex w-full min-w-0 flex-col items-start rounded-xl px-3 pb-2.5 pt-10 text-left">
              <span className="max-w-full truncate text-[14px] font-medium text-ink">{shown}</span>
              <span className="max-w-full truncate text-[12px] text-ink-secondary">{t(`callVoice.vibe.${id}`)}</span>
            </button>
            {picked && badge && <span aria-hidden className="pointer-events-none absolute left-3 top-2.5">{badge}</span>}
            <button type="button" aria-label={t(playing === id ? "callVoice.stop" : "callVoice.play", { name: shown })} aria-pressed={playing === id}
              onClick={() => preview(id)}
              className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-ink/10 text-ink-secondary hover:text-ink max-md:size-8">
              {playing === id ? <Pause size={12} aria-hidden className="fill-current" /> : <Play size={12} aria-hidden className="fill-current" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The per-bot call panel: speed, volume (this device), style, voice and language. */
export function CallSettings({ bot, language = true, className }: { bot: Bot; language?: boolean; className?: string }) {
  const { t, locale } = useI18n();
  const prefs = useCallPrefs(bot);
  const volume = useCallVolume();
  const { playing, preview } = usePreview(prefs.language ?? (locale === "ko" ? "ko" : "en"));
  return (
    // tabIndex keeps a press on the panel from focusing the message box under it
    <div data-call-settings="" tabIndex={-1} className={cn("flex flex-col gap-2 outline-none", className)}>
      <Slider label={t("callMenu.speed")} value={prefs.speed} range={CALL_SPEED} text={`${prefs.speed.toFixed(1)}x`}
        onChange={(speed) => prefs.set({ speed: Math.round(speed * 10) / 10 })} />
      <Slider label={t("callMenu.volume")} value={volume} range={CALL_VOLUME} text={`${Math.round(volume * 100)}%`} onChange={setCallVolume} />
      <div className="flex items-center justify-between gap-3">
        <span className={LABEL}>{t("callMenu.style")}</span>
        <div role="radiogroup" aria-label={t("callMenu.style")} className="flex gap-0.5 rounded-lg bg-inset p-[3px]">
          {CALL_STYLES.map((style) => (
            <button key={style} type="button" role="radio" aria-checked={style === prefs.style} onClick={() => prefs.set({ style })}
              className={cn("px-2 py-0.5 text-[12px] font-medium max-md:min-h-8", PILL,
                style === prefs.style ? "bg-raised text-ink shadow-sm ring-1 ring-hairline/60" : "text-ink-secondary hover:text-ink")}>
              {t(`callMenu.style.${style}`)}
            </button>
          ))}
        </div>
      </div>
      <VoiceGrid value={prefs.voice} onPick={(voice) => prefs.set({ voice })} playing={playing} preview={preview}
        badge={<BotAvatar bot={bot} state="happy" size={20} />} />
      {language && (
        <div className="flex items-center justify-between gap-3">
          <span className={LABEL}>{t("callMenu.language")}</span>
          <CallLanguage bot={bot} />
        </div>
      )}
    </div>
  );
}

/** Right-click or long-press on the wrapped Call button opens the panel above it; a plain click still calls. */
export function CallSettingsHold({ bot, children }: { bot: Bot; children: ReactNode }) {
  const { t } = useI18n();
  const anchor = useRef<HTMLSpanElement>(null);
  const press = useRef<{ x: number; y: number; held: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const shown = usePresence(at);
  const close = useCallback(() => setAt(null), []);
  const open = () => anchor.current && setAt(anchor.current.getBoundingClientRect());
  const release = () => {
    if (press.current) clearTimeout(press.current.timer);
    const held = press.current?.held;
    press.current = null;
    return held;
  };
  useEffect(() => () => clearTimeout(press.current?.timer), []);
  // The Language menu is portaled outside the panel.
  useListMenuDismiss('[data-call-settings-menu], [role="menu"]', "[data-call-hold]", !at, close);
  useBackLayer(Boolean(at), close);
  const rect = shown.value;
  const width = Math.min(360, window.innerWidth - 16);
  return (
    <span ref={anchor} data-call-hold="" className="flex select-none [-webkit-touch-callout:none]"
      onContextMenu={(event) => {
        event.preventDefault();
        open();
      }}
      onTouchStart={(event) => {
        release();
        const touch = event.touches[0];
        if (!touch || event.touches.length > 1) return;
        const held = { x: touch.clientX, y: touch.clientY, held: false, timer: setTimeout(() => {
          held.held = true;
          hapticTick();
          open();
        }, LONG_PRESS_MS) };
        press.current = held;
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        const held = press.current;
        if (held && !held.held && (!touch || Math.hypot(touch.clientX - held.x, touch.clientY - held.y) > LONG_PRESS_SLOP)) release();
      }}
      onTouchEnd={(event) => {
        if (!release()) return;
        // cancelling the touchend is what keeps the hold from placing the call
        if (event.cancelable) event.preventDefault();
        guardMenuTouch(document, true);
      }}
      onTouchCancel={() => void release()}>
      {children}
      {shown.mounted && rect && createPortal(
        <div data-call-settings-menu="" role="dialog" aria-label={t("callMenu.open")} data-closing={shown.closing || undefined} inert={shown.closing}
          style={{ width, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 8, maxHeight: rect.top - 16 }}
          className={cn(MENU_CLASS, "origin-bottom-right overflow-y-auto p-3")}>
          <CallSettings bot={bot} />
        </div>,
        document.body,
      )}
    </span>
  );
}

/** Bot details rows: Voice opens the panel in place, Language picks the call language. */
export function VoiceChatSettings({ bot }: { bot: Bot }) {
  const { t } = useI18n();
  const { voice, speed } = useCallPrefs(bot);
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section aria-label={t("callMenu.voiceChat")}>
      <h3 className="mb-1.5 px-1 text-[13px] font-medium text-ink-secondary">{t("callMenu.voiceChat")}</h3>
      <div className={DETAILS_BOX}>
        <div className={DETAILS_ROW}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium text-ink">{t("callMenu.voice")}</span>
            <button type="button" data-call-voice-row="" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className={cn(ROW_BUTTON, "gap-1 text-ink")}>
              <span>{`${voiceLabel(t, voice)} ${speed.toFixed(1)}x`}</span>
              <ChevronDown size={12} aria-hidden className={cn("text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
            </button>
          </div>
          <Fold open={open} id={id}>
            <CallSettings bot={bot} language={false} className="mt-3" />
          </Fold>
        </div>
        <div className={DETAILS_ROW}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium text-ink">{t("callMenu.language")}</span>
            <CallLanguage bot={bot} />
          </div>
        </div>
      </div>
    </section>
  );
}
