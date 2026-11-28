import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Pause, Play, Settings } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { useActiveCall } from "@/lib/live-call/active";
import { setCallCaptions, useCallCaptions } from "@/lib/live-call/captions";
import { voiceLabel } from "@/lib/live-call/voice-label";
import { CALL_VOLUME, setCallVolume, useCallVolume } from "@/lib/live-call/volume";
import { MENU_ITEM_HOVER } from "@/lib/menu-style";
import { hapticTick } from "@/lib/phone-swipe";
import { markCut } from "@/lib/scroll-cut";
import { useBackLayer } from "@/lib/use-back-layer";
import { guardMenuTouch, useListMenuDismiss } from "@/lib/use-hold-menu";
import { usePresence } from "@/lib/use-presence";
import { useIsPhone, useSheetSwipe } from "@/lib/use-phone-swipe";
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from "@/lib/use-touch-drag";
import { CALL_SPEED, CALL_STYLES, LIVE_VOICE, LIVE_VOICES, OUTPUT_GAIN, callPace, type CallAnswer, type CallPrefs, type CallStyle, type LiveVoice } from "../../shared/live-call";
import { BotAvatar } from "./Avatar";
import { DetailsSwitch } from "./BotDetailsRows";
import { Fold } from "./Fold";
import { MENU_CLASS } from "./MessageMenu";
import { SegmentedRow } from "./Segmented";
import { AccountPicker } from "./UsageAccounts";

const LABEL = "shrink-0 text-[14px] font-medium text-ink";
const PILL = "rounded-[max(0px,calc(var(--radius-lg)_-_3px))]";
const FEATURED_VOICES: readonly LiveVoice[] = LIVE_VOICES.slice(0, 3);
const MORE_VOICES: readonly LiveVoice[] = LIVE_VOICES.slice(3);
const SLIDER = cn(
  "h-8 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent focus-visible:outline-none",
  "[&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-accent)_var(--fill),color-mix(in_srgb,var(--color-ink)_14%,transparent)_var(--fill))]",
  "[&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:ring-1 [&::-webkit-slider-thumb]:ring-ink/15 focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-focus",
  "[&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-ink/15 [&::-moz-range-progress]:h-2 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-accent [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:ring-1 [&::-moz-range-thumb]:ring-ink/15",
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

/** No preview during a call: it would play into the open mic, and a pick is heard on the next words anyway. */
function usePreview(language: "en" | "ko", speed: number, style: CallStyle): { playing: LiveVoice | null; preview?: (name: LiveVoice) => void } {
  const onCall = Boolean(useActiveCall());
  const [playing, setPlaying] = useState<LiveVoice | null>(null);
  const clip = useRef<HTMLAudioElement | null>(null);
  const stop = () => {
    clip.current?.pause();
    clip.current = null;
    setPlaying(null);
  };
  useEffect(() => (onCall ? stop() : undefined), [onCall]);
  useEffect(() => () => clip.current?.pause(), []);
  // the call's own level and pitch-kept speed, so the sample sounds like the call
  const level = OUTPUT_GAIN * useCallVolume();
  const pace = callPace({ speed, style });
  useEffect(() => {
    if (!clip.current) return;
    clip.current.volume = level;
    clip.current.playbackRate = pace;
  }, [level, pace]);
  const preview = (name: LiveVoice) => {
    const was = playing;
    stop();
    if (was === name) return;
    const audio = new Audio(`/voice-preview/${name}-${language}.mp3`);
    audio.volume = level;
    audio.playbackRate = pace;
    audio.onended = () => clip.current === audio && stop();
    clip.current = audio;
    setPlaying(name);
    audio.play().catch(() => clip.current === audio && stop());
  };
  return { playing, preview: onCall ? undefined : preview };
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

/** Who answers calls, app-wide: the bot itself (its reply read out) or the Gemini voice. A call on now moves over once nothing is in flight. */
function CallAnswerRow() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const latest = useRef(0);
  const config = useRef(state.config);
  config.current = state.config;
  const value = state.config?.liveCall?.answer ?? "gemini";
  const show = (answer?: CallAnswer) => config.current && dispatch({ type: "configStatus", config: { ...config.current, liveCall: { voice: LIVE_VOICE, ...config.current.liveCall, answer } } });
  const pick = (answer: CallAnswer) => {
    const mine = ++latest.current;
    const was = config.current?.liveCall?.answer;
    // Shown at once, so a call placed before the save lands answers as picked; only the newest pick's reply counts.
    show(answer);
    void api("/api/config", { method: "PATCH", body: JSON.stringify({ liveCall: { answer } }) }).then(
      (saved: ConfigStatus) => mine === latest.current && dispatch({ type: "configStatus", config: saved }),
      () => mine === latest.current && show(was),
    );
  };
  return (
    <SegmentedRow<CallAnswer> label={t("callMenu.answer")} value={value}
      options={(["bot", "gemini"] as const).map((id) => ({ id, label: t(`callMenu.answer.${id}`) }))} onChange={pick} />
  );
}

function VoiceCard({ id, picked, compact, onPick, playing, preview, badge }: {
  id: LiveVoice;
  picked: boolean;
  compact?: boolean;
  onPick: (voice: LiveVoice) => void;
  playing: LiveVoice | null;
  preview?: (voice: LiveVoice) => void;
  badge?: ReactNode;
}) {
  const { t } = useI18n();
  const shown = voiceLabel(t, id);
  return (
    <div data-call-voice={id} className={cn("relative flex items-center rounded-lg ring-1", picked ? "bg-raised-hover ring-ink-secondary/40" : "ring-hairline hover:bg-raised-hover/50")}>
      <button type="button" role="radio" aria-checked={picked} onClick={() => onPick(id)}
        className={cn(
          "flex w-full min-w-0 items-center rounded-lg text-left",
          compact ? "min-h-9 gap-1.5 px-2 py-1.5 max-md:min-h-10" : "gap-2 px-2.5 py-2",
          preview && (compact ? "pr-8" : "pr-9"),
        )}>
        {picked && badge && <span aria-hidden className="shrink-0">{badge}</span>}
        {compact ? (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{shown}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="max-w-full truncate text-[13px] font-medium text-ink">{shown}</span>
            <span className="max-w-full truncate text-[11.5px] text-ink-secondary">{t(`callVoice.vibe.${id}`)}</span>
          </span>
        )}
      </button>
      {preview && <button type="button" aria-label={t(playing === id ? "callVoice.stop" : "callVoice.play", { name: shown })} aria-pressed={playing === id}
        onClick={() => preview(id)}
        className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full bg-ink/10 text-ink-secondary hover:text-ink max-md:size-7">
        {playing === id ? <Pause size={11} aria-hidden className="fill-current" /> : <Play size={11} aria-hidden className="fill-current" />}
      </button>}
    </div>
  );
}

/** Scrollable grid of voice cards with bottom fade while more voices sit below. */
export function VoiceGrid({ label, voices = LIVE_VOICES, embedded, value, onPick, playing, preview, badge }: {
  label?: string;
  voices?: readonly LiveVoice[];
  embedded?: boolean;
  value: LiveVoice;
  onPick: (voice: LiveVoice) => void;
  playing: LiveVoice | null;
  preview?: (voice: LiveVoice) => void;
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
    <div ref={grid} role={embedded ? undefined : "radiogroup"} aria-label={embedded ? undefined : label ?? t("callMenu.voice")} data-call-voices="" onScroll={(event) => markCut(event.currentTarget)}
      className="-mx-1 mt-1.5 grid max-h-52 grid-cols-2 gap-1.5 overflow-y-auto overscroll-contain p-1 data-[cut]:[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]">
      {voices.map((id) => (
        <VoiceCard key={id} id={id} picked={id === value} onPick={onPick} playing={playing} preview={preview} badge={badge} />
      ))}
    </div>
  );
}

/** Compact call panel: volume, answered by, and featured voices one tap away; all voices and extra controls fold open on demand. */
export function CallSettings({ bot, language = true, className }: { bot: Bot; language?: boolean; className?: string }) {
  const { t, locale } = useI18n();
  const prefs = useCallPrefs(bot);
  const volume = useCallVolume();
  const captions = useCallCaptions();
  const { playing, preview } = usePreview(prefs.language ?? (locale === "ko" ? "ko" : "en"), prefs.speed, prefs.style);
  const [voicesOpen, setVoicesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const voicesId = useId();
  const moreId = useId();
  const badge = <BotAvatar bot={bot} state="happy" size={16} />;
  // Keep a non-featured active voice visible while the full list is folded; avoid duplicating it once expanded.
  const quickVoices = !voicesOpen && !FEATURED_VOICES.includes(prefs.voice)
    ? [...FEATURED_VOICES, prefs.voice]
    : FEATURED_VOICES;
  return (
    // tabIndex keeps a press on the panel from focusing the message box under it
    <div data-call-settings="" tabIndex={-1} className={cn("flex flex-col gap-2.5 outline-none", className)}>
      <CallAnswerRow />
      <Slider label={t("callMenu.volume")} value={volume} range={CALL_VOLUME} text={`${Math.round(volume * 100)}%`} onChange={setCallVolume} />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>{t("callMenu.voice")}</span>
          <button type="button" data-call-voice-toggle="" aria-expanded={voicesOpen} aria-controls={voicesId} aria-label={t("callMenu.allVoices")}
            onClick={() => setVoicesOpen((open) => !open)}
            className={cn("-mr-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-ink-secondary hover:text-ink max-md:min-h-8", MENU_ITEM_HOVER)}>
            <span>{t("callMenu.all")}</span>
            <ChevronDown size={13} aria-hidden className={cn("shrink-0 transition-transform motion-reduce:transition-none", voicesOpen && "rotate-180")} />
          </button>
        </div>
        <div role="radiogroup" aria-label={t("callMenu.voice")} className="flex flex-col">
          <div className={cn("grid gap-1.5", quickVoices.length === 4 ? "grid-cols-2" : "grid-cols-3")}>
            {quickVoices.map((id) => (
              <VoiceCard key={id} id={id} compact picked={id === prefs.voice} onPick={(voice) => prefs.set({ voice })} playing={playing} preview={preview} badge={badge} />
            ))}
          </div>
          <Fold open={voicesOpen} id={voicesId}>
            <VoiceGrid voices={MORE_VOICES} embedded value={prefs.voice} onPick={(voice) => prefs.set({ voice })} playing={playing} preview={preview} badge={badge} />
          </Fold>
        </div>
      </div>
      <div className="border-t border-hairline/40 pt-1">
        <button type="button" data-call-more="" aria-expanded={moreOpen} aria-controls={moreId}
          onClick={() => setMoreOpen((open) => !open)}
          className={cn("-mx-1.5 flex w-[calc(100%+0.75rem)] items-center justify-between rounded-lg px-1.5 py-1.5 text-left max-md:min-h-10", MENU_ITEM_HOVER)}>
          <span className={cn("text-[13.5px] font-medium", moreOpen ? "text-ink" : "text-ink-secondary")}>{t("callMenu.more")}</span>
          <ChevronDown size={15} aria-hidden className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", moreOpen && "rotate-180")} />
        </button>
        <Fold open={moreOpen} id={moreId}>
          <div className="flex flex-col gap-2.5 pt-2">
            <div className="flex items-center justify-between gap-3">
              <span className={LABEL}>{t("callMenu.captions")}</span>
              <DetailsSwitch on={captions} label={t("callMenu.captions")} onToggle={() => setCallCaptions(!captions)} />
            </div>
            <Slider label={t("callMenu.speed")} value={prefs.speed} range={CALL_SPEED} text={`${prefs.speed.toFixed(1)}x`}
              onChange={(speed) => prefs.set({ speed: Math.round(speed * 10) / 10 })} />
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
            {language && (
              <div className="flex items-center justify-between gap-3">
                <span className={LABEL}>{t("callMenu.language")}</span>
                <CallLanguage bot={bot} />
              </div>
            )}
          </div>
        </Fold>
      </div>
    </div>
  );
}

export const CALL_ICON = "flex size-8 shrink-0 items-center justify-center rounded-full max-md:size-10";

export function CallGear({ bot, className }: { bot: Bot; className?: string }) {
  const { t } = useI18n();
  return (
    <CallSettingsHold bot={bot} tap>
      <button type="button" aria-label={t("callMenu.open")} title={t("callMenu.open")} className={cn(CALL_ICON, "text-ink-secondary hover:bg-control hover:text-ink", className)}>
        <Settings size={17} />
      </button>
    </CallSettingsHold>
  );
}

/** Right-click or long-press on the wrapped Call button opens the panel above it; a plain click still calls, or with `tap` toggles it. */
export function CallSettingsHold({ bot, children, tap }: { bot: Bot; children: ReactNode; tap?: boolean }) {
  const { t } = useI18n();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; held: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const shown = usePresence(at);
  const close = useCallback(() => setAt(null), []);
  const phone = useIsPhone();
  useSheetSwipe(panel, Boolean(at) && phone, close);
  const open = () => anchor.current && setAt(anchor.current.getBoundingClientRect());
  const release = () => {
    if (press.current) clearTimeout(press.current.timer);
    const held = press.current?.held;
    press.current = null;
    return held;
  };
  useEffect(() => () => clearTimeout(press.current?.timer), []);
  // The Language menu is portaled outside the panel; End is never a dismiss tap, it always ends the call.
  useListMenuDismiss(`[data-call-settings-menu], [role="menu"], [data-call-end]${tap ? ", [data-call-tap]" : ""}`, "[data-call-hold]", !at, close);
  useBackLayer(Boolean(at), close);
  const rect = shown.value;
  const compact = window.innerWidth < 768;
  const width = Math.min(compact ? 358 : 320, window.innerWidth - 16);
  return (
    <span ref={anchor} data-call-hold="" className="flex select-none [-webkit-touch-callout:none]"
      data-call-tap={tap || undefined}
      onClick={tap ? (event) => {
        // the menu is portaled, but its clicks still bubble here through the React tree
        if (!(event.target instanceof Node && anchor.current?.contains(event.target))) return;
        if (at) close();
        else open();
      } : undefined}
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
        <div ref={panel} data-call-settings-menu="" role="dialog" aria-label={t("callMenu.open")} data-closing={shown.closing || undefined} inert={shown.closing}
          style={{
            width,
            left: compact ? Math.max(8, Math.round((window.innerWidth - width) / 2)) : Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
            bottom: window.innerHeight - rect.top + 8,
            maxHeight: rect.top - 16,
          }}
          className={cn(MENU_CLASS, "origin-bottom-right overflow-y-auto p-3")}>
          <CallSettings bot={bot} />
        </div>,
        document.body,
      )}
    </span>
  );
}
