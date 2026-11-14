import memoryClip from "@/assets/whats-new/1.0.246-memory.webp";
import memoryLightClip from "@/assets/whats-new/1.0.246-memory-light.webp";
import verifyClip from "@/assets/whats-new/1.0.246-verify.webp";
import hydrogenClip from "@/assets/whats-new/1.0.263-hydrogen.webp";
import hydrogenLightClip from "@/assets/whats-new/1.0.263-hydrogen-light.webp";
import mapClip from "@/assets/whats-new/1.0.263-map.webp";
import mapLightClip from "@/assets/whats-new/1.0.263-map-light.webp";
import { newerRelease } from "../../shared/release-order";
import type { LocaleId } from "./i18n";

type Copy = Record<LocaleId, string>;

export type WhatsNewTile = {
  clip: string;
  lightClip?: string;
  title: Copy;
  line: Copy;
  /** "memory" opens the current bot's Memory tab; a how-to line is for features that start on their own. */
  show: "memory" | Copy;
};

export type WhatsNewEntry = { title: Copy; tiles: [WhatsNewTile, WhatsNewTile]; more: Copy };

// One entry per release that has notes; a release with no entry shows the newest earlier one still unseen.
export const WHATS_NEW: Record<string, WhatsNewEntry> = {
  "1.0.246": {
    title: { en: "New in Wink 1.0.246", ko: "Wink 1.0.246 새 기능" },
    tiles: [
      {
        clip: memoryClip,
        lightClip: memoryLightClip,
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
  "1.0.263": {
    title: { en: "New in Wink 1.0.263", ko: "Wink 1.0.263 새 기능" },
    tiles: [
      {
        clip: mapClip,
        lightClip: mapLightClip,
        title: { en: "Watch every worker on the Map", ko: "Map에서 모든 워커 보기" },
        line: { en: "Your project as a family tree, live.", ko: "프로젝트를 가계도처럼 실시간으로." },
        show: { en: "Open the side pane's Map tab while workers run.", ko: "워커가 일할 때 사이드 패널의 Map 탭을 열어 보세요." },
      },
      {
        clip: hydrogenClip,
        lightClip: hydrogenLightClip,
        title: { en: "Gemini 4 Carbon + Hydrogen are here", ko: "Gemini 4 Carbon + Hydrogen 추가" },
        line: { en: "Google's fast Gemini for everyday work.", ko: "일상 작업에 빠른 Google Gemini." },
        show: { en: "Press Alt+M and pick Gemini 4 Carbon or Hydrogen.", ko: "Alt+M을 누르고 Gemini 4 Carbon 또는 Hydrogen을 고르세요." },
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
};

/** The newest notes after `seen` that the running release has. */
export function unseenRelease(release: string, seen: string | null, releases = Object.keys(WHATS_NEW)): string | null {
  let newest: string | null = null;
  for (const entry of releases) {
    if (newerRelease(entry, release) || (seen && !newerRelease(entry, seen))) continue;
    if (!newest || newerRelease(entry, newest)) newest = entry;
  }
  return newest;
}

export const releaseNotesUrl = (release: string) => `https://github.com/aiedwardyi/orbit-releases/releases/tag/v${release}`;
