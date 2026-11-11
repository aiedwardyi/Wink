import { AudioLines, Coins, MessageSquareText, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n, type LocaleId } from "@/lib/i18n";

const INTRO_SEEN = "wink.liveCall.intro";

const WORDS: Record<LocaleId, { title: string; lines: [string, string, string]; start: string; later: string }> = {
  en: {
    title: "Voice call",
    lines: ["Talk, type and send pictures at the same time", "Saved to the chat, so your bot remembers", "Uses your Gemini credit while live. End stops it."],
    start: "Start call",
    later: "Not now",
  },
  ko: {
    title: "음성 통화",
    lines: ["말하고, 입력하고, 사진도 함께 보낼 수 있습니다", "채팅에 저장되어 봇이 기억합니다", "통화 중에는 Gemini 크레딧을 사용합니다. 종료하면 멈춥니다."],
    start: "통화 시작",
    later: "나중에",
  },
};

const ICONS: LucideIcon[] = [AudioLines, MessageSquareText, Coins];

export function seenIntro(): boolean {
  try {
    return Boolean(localStorage.getItem(INTRO_SEEN));
  } catch {
    return false;
  }
}

export function CallIntro({ onStart, onLater }: { onStart: () => void; onLater: () => void }) {
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const start = () => {
    try {
      localStorage.setItem(INTRO_SEEN, "1");
    } catch {
      // shown again next time
    }
    onStart();
  };
  const target = "inline-flex min-h-9 items-center justify-center rounded-full px-4 text-sm font-medium max-md:min-h-12 max-md:flex-1";
  return (
    <div data-call-intro className="mb-2 rounded-2xl border border-hairline/50 bg-card p-3 shadow-sm">
      <p className="px-1 text-sm font-medium text-ink">{words.title}</p>
      <ul className="mt-2 space-y-1.5 px-1">
        {words.lines.map((line, i) => {
          const Icon = ICONS[i]!;
          return (
            <li key={i} className="flex items-center gap-2.5 text-[13px] text-ink-secondary">
              <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
                <Icon size={14} />
              </span>
              {line}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onLater} className={cn(target, "text-ink-secondary hover:bg-control hover:text-ink")}>{words.later}</button>
        <button type="button" onClick={start} className={cn(target, "bg-accent text-accent-ink")}>{words.start}</button>
      </div>
    </div>
  );
}
