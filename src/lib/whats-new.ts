import memoryClip from "@/assets/whats-new/1.0.246-memory.webp";
import verifyClip from "@/assets/whats-new/1.0.246-verify.webp";
import type { LocaleId } from "./i18n";

type Copy = Record<LocaleId, string>;

export type WhatsNewTile = {
  clip: string;
  title: Copy;
  line: Copy;
  /** "memory" opens the current bot's Memory tab; a how-to line is for features that start on their own. */
  show: "memory" | Copy;
};

export type WhatsNewEntry = { title: Copy; tiles: [WhatsNewTile, WhatsNewTile]; more: Copy };

// One entry per release that has notes; a release with no entry shows nothing.
export const WHATS_NEW: Record<string, WhatsNewEntry> = {
  "1.0.246": {
    title: { en: "New in Wink 1.0.246", ko: "Wink 1.0.246 새 기능" },
    tiles: [
      {
        clip: memoryClip,
        title: { en: "See what your bot remembers", ko: "봇이 기억하는 것 보기" },
        line: { en: "Notes sorted by topic, in Bot Details.", ko: "봇 세부 정보에서 주제별로 봐요." },
        show: "memory",
      },
      {
        clip: verifyClip,
        title: { en: "Live Verify checks your site", ko: "Live Verify가 사이트를 확인" },
        line: { en: "Desktop and phone, after every build.", ko: "만들 때마다 데스크톱과 휴대폰에서." },
        show: {
          en: "Starts on its own when a bot builds a page. Press Watch to see the cursors live.",
          ko: "봇이 페이지를 만들면 저절로 시작돼요. 보기를 누르면 커서가 실시간으로 보여요.",
        },
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
};

export const releaseNotesUrl = (release: string) => `https://github.com/aiedwardyi/orbit-releases/releases/tag/v${release}`;
