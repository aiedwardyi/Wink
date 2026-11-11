import type { ComponentType } from "react";
import { AudioLines, MessageSquareText } from "lucide-react";

import { useI18n, type LocaleId } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { GeminiMark } from "./ProviderIcons";

const INTRO_SEEN = "wink.liveCall.intro";
const INTRO_COPY: "A" | "B" = "A";

const COPY: Record<"A" | "B", Record<LocaleId, { title: string; lines: [string, string, string] }>> = {
  A: {
    en: {
      title: "Voice call",
      lines: ["Talk, type and send pictures at the same time", "Saved to the chat, so your bot remembers", "Uses your Gemini credit while live. End stops it."],
    },
    ko: {
      title: "음성 통화",
      lines: ["말하고, 입력하고, 사진도 함께 보낼 수 있습니다", "채팅에 저장되어 봇이 기억합니다", "통화 중에는 Gemini 크레딧을 사용합니다. 종료하면 멈춥니다."],
    },
  },
  B: {
    en: {
      title: "Talk with your bot",
      lines: ["Just say it. It opens your files and gets work done.", "Everything lands in the chat, so nothing is forgotten.", "Runs on your Gemini credit. End anytime."],
    },
    ko: {
      title: "봇과 대화해 보세요",
      lines: ["말만 하세요. 파일을 열고 일을 처리합니다.", "대화는 모두 채팅에 남아, 봇이 잊지 않습니다.", "Gemini 크레딧으로 작동합니다. 언제든 끝낼 수 있습니다."],
    },
  },
};

const BUTTONS: Record<LocaleId, { start: string; later: string }> = {
  en: { start: "Start call", later: "Not now" },
  ko: { start: "통화 시작", later: "나중에" },
};

const ICONS: Array<ComponentType<{ size?: number }>> = [AudioLines, MessageSquareText, GeminiMark];

export function seenIntro(): boolean {
  try {
    return Boolean(localStorage.getItem(INTRO_SEEN));
  } catch {
    return false;
  }
}

export function CallIntro({ closing, onStart, onLater }: { closing: boolean; onStart: () => void; onLater: () => void }) {
  const { locale } = useI18n();
  const words = COPY[INTRO_COPY][locale] ?? COPY[INTRO_COPY].en;
  const buttons = BUTTONS[locale] ?? BUTTONS.en;
  const start = () => {
    try {
      localStorage.setItem(INTRO_SEEN, "1");
    } catch {
      // shown again next time
    }
    onStart();
  };
  return (
    <ConfirmDialog title={words.title} confirmLabel={buttons.start} cancelLabel={buttons.later} danger={false} light closing={closing} onConfirm={start} onCancel={onLater}>
      <ul data-call-intro className="mt-4 space-y-3">
        {words.lines.map((line, i) => {
          const Icon = ICONS[i]!;
          return (
            <li key={i} className="flex items-center gap-3 text-[13px] leading-snug text-ink-secondary">
              <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
                <Icon size={15} />
              </span>
              {line}
            </li>
          );
        })}
      </ul>
    </ConfirmDialog>
  );
}
