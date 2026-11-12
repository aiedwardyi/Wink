import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n, type LocaleId } from "@/lib/i18n";
import { SEND_HOLD_MS } from "@/lib/send-hold";
import { api, useStore } from "@/state/store";
import { LIVE_LANGUAGES, LIVE_VOICE, LIVE_VOICES, type LiveLanguage, type LiveVoice } from "../../shared/live-call";
import { MENU_CLASS, menuKeyDown, useMenuDismiss } from "./MessageMenu";

// Google's one-word style for each voice.
const STYLES: Record<LocaleId, Record<LiveVoice, string>> = {
  en: { Zephyr: "Bright", Kore: "Firm", Sulafat: "Warm", Puck: "Upbeat", Achird: "Friendly", Charon: "Informative" },
  ko: { Zephyr: "밝은", Kore: "단단한", Sulafat: "따뜻한", Puck: "경쾌한", Achird: "친근한", Charon: "또렷한" },
};

const COPY: Record<LocaleId, { title: string; voice: string; language: string; auto: string; autoHint: string; next: string; failed: string }> = {
  en: { title: "Call options", voice: "Voice", language: "Language", auto: "Auto", autoHint: "English or Korean, as you speak", next: "Your next call uses it.", failed: "Couldn't save. Try again." },
  ko: { title: "통화 설정", voice: "목소리", language: "언어", auto: "자동", autoHint: "말하는 대로 영어나 한국어로", next: "다음 통화부터 적용돼요.", failed: "저장하지 못했어요. 다시 시도해 주세요." },
};

const NAMES: Record<Exclude<LiveLanguage, "auto">, string> = { en: "English", ko: "한국어" };
const SLOP = 10;

/** Right-click, or a still one-finger hold on a phone, opens the menu; the hold's own tap is swallowed. */
export function useCallMenuPress(open: () => void) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const held = useRef(false);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  return {
    held: () => {
      const was = held.current;
      held.current = false;
      return was;
    },
    props: {
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        cancel();
        open();
      },
      onTouchStart: (e: React.TouchEvent) => {
        cancel();
        held.current = false;
        const touch = e.touches[0];
        if (!touch || e.touches.length > 1) return;
        press.current = { x: touch.clientX, y: touch.clientY, timer: setTimeout(() => { press.current = null; held.current = true; open(); }, SEND_HOLD_MS) };
      },
      onTouchMove: (e: React.TouchEvent) => {
        const touch = e.touches[0];
        if (press.current && (!touch || Math.hypot(touch.clientX - press.current.x, touch.clientY - press.current.y) > SLOP)) cancel();
      },
      onTouchEnd: (e: React.TouchEvent) => {
        cancel();
        if (held.current) e.preventDefault();
      },
      onTouchCancel: cancel,
    },
  };
}

export function CallMenu({ opener, onCall, onClose }: { opener: HTMLElement; onCall: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { locale } = useI18n();
  const words = COPY[locale] ?? COPY.en;
  const styles = STYLES[locale] ?? STYLES.en;
  const voice = state.config?.liveCall?.voice ?? LIVE_VOICE;
  const language = state.config?.liveCall?.language ?? "auto";
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const rect = opener.getBoundingClientRect();
  useMenuDismiss(ref, opener, onClose);

  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);

  const save = async (liveCall: { voice: LiveVoice } | { language: LiveLanguage }) => {
    setFailed(false);
    try {
      dispatch({ type: "configStatus", config: await api("/api/config", { method: "PUT", body: JSON.stringify({ liveCall }) }) });
      onClose();
      opener.focus({ preventScroll: true });
    } catch {
      setFailed(true);
    }
  };

  const head = "px-3.5 pb-1 pt-1.5 text-[12px] font-medium text-ink-secondary";
  const row = "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70 max-md:min-h-11";
  const tick = (on: boolean) => <Check size={15} aria-hidden className={cn("shrink-0 text-accent", !on && "invisible")} />;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={words.title}
      data-call-menu
      style={{ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) }}
      onKeyDown={(e) => menuKeyDown(ref, e)}
      className={cn(MENU_CLASS, "w-60")}
    >
      <p className={head}>{words.voice}</p>
      {LIVE_VOICES.map((name) => (
        <button key={name} type="button" role="menuitemradio" aria-checked={name === voice} data-call-voice={name} onClick={() => void save({ voice: name })} className={row}>
          {tick(name === voice)}
          <span className="min-w-0 flex-1 truncate">{styles[name]}</span>
          <span className="shrink-0 text-[12px] text-ink-secondary">{name}</span>
        </button>
      ))}
      <div className="mx-3 my-1.5 h-px bg-hairline/50" />
      <p className={head}>{words.language}</p>
      {LIVE_LANGUAGES.map((code) => (
        <button key={code} type="button" role="menuitemradio" aria-checked={code === language} data-call-language={code} onClick={() => void save({ language: code })} className={row}>
          {tick(code === language)}
          {code === "auto"
            ? <span className="min-w-0 flex-1"><span className="block">{words.auto}</span><span className="block text-[12px] text-ink-secondary">{words.autoHint}</span></span>
            : <span lang={code} className="min-w-0 flex-1 truncate">{NAMES[code]}</span>}
        </button>
      ))}
      {onCall && <p className="px-3.5 pb-1 pt-1 text-[12px] text-ink-secondary">{words.next}</p>}
      {failed && <p role="alert" className="px-3.5 pb-1 pt-1 text-[12px] text-danger">{words.failed}</p>}
    </div>,
    document.body,
  );
}
