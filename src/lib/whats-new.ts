import memoryClip from "@/assets/whats-new/1.0.246-memory.webp";
import memoryLightClip from "@/assets/whats-new/1.0.246-memory-light.webp";
import hydrogenClip from "@/assets/whats-new/1.0.263-hydrogen.webp";
import hydrogenLightClip from "@/assets/whats-new/1.0.263-hydrogen-light.webp";
import mapClip from "@/assets/whats-new/1.0.263-map.webp";
import mapLightClip from "@/assets/whats-new/1.0.263-map-light.webp";
import themesClip from "@/assets/whats-new/1.0.276-themes.webp";
import dialClip from "@/assets/whats-new/1.0.277-dial.webp";
import workersClip from "@/assets/whats-new/1.0.278-workers.webp";
import { newerRelease } from "../../shared/release-order";
import type { LocaleId } from "./i18n";
import type { SkinId } from "./skins";

type Copy = Record<LocaleId, string>;

/** What Show me opens in this chat. */
export type WhatsNewTarget = "memory" | "map" | "models" | "workers" | { skins: SkinId[] };

/** Every tile is a moving clip plus a Show me that opens the feature; whats-new.test.ts enforces it. `still` marks an old tile whose clip is one frame. */
export type WhatsNewTile = { clip: string; lightClip?: string; still?: true; title: Copy; line: Copy; show: WhatsNewTarget };

export type WhatsNewEntry = { title: Copy; tiles: [WhatsNewTile] | [WhatsNewTile, WhatsNewTile]; more: Copy };

const themesTile: WhatsNewTile = {
  clip: themesClip,
  title: { en: "Four new themes that move", ko: "움직이는 새 테마 4개" },
  line: { en: "Samurai Ink, Night Rain, Warp and Circuit.", ko: "사무라이 잉크, 나이트 레인, 워프, 서킷." },
  show: { skins: ["samurai-ink", "night-rain", "warp", "circuit"] },
};

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
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.263": {
    title: { en: "New in Wink 1.0.263", ko: "Wink 1.0.263 새 기능" },
    tiles: [
      {
        clip: mapClip,
        lightClip: mapLightClip,
        title: { en: "Watch every worker on the Map", ko: "Map에서 모든 작업자 보기" },
        line: { en: "Your project as a family tree, live.", ko: "프로젝트를 가계도처럼 실시간으로." },
        show: "map",
      },
      {
        clip: hydrogenClip,
        lightClip: hydrogenLightClip,
        title: { en: "Gemini 4 Carbon + Hydrogen are here", ko: "Gemini 4 Carbon + Hydrogen 추가" },
        line: { en: "Google's fast Gemini for everyday work.", ko: "일상 작업에 빠른 Google Gemini." },
        show: "models",
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.273": {
    title: { en: "New in Wink 1.0.273", ko: "Wink 1.0.273 새 기능" },
    tiles: [themesTile],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.276": {
    title: { en: "New in Wink 1.0.276", ko: "Wink 1.0.276 새 기능" },
    tiles: [themesTile],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.277": {
    title: { en: "New in Wink 1.0.277", ko: "Wink 1.0.277 새 기능" },
    tiles: [
      {
        clip: dialClip,
        still: true,
        title: { en: "The model dial is on for everyone", ko: "이제 모두가 모델 다이얼을 써요" },
        line: { en: "Pick a model and its effort on one dial.", ko: "다이얼 하나로 모델과 추론 강도를 골라요." },
        show: "models",
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.278": {
    title: { en: "New in Wink 1.0.278", ko: "Wink 1.0.278 새 기능" },
    tiles: [
      {
        clip: workersClip,
        still: true,
        title: { en: "Workers live in the side pane", ko: "작업자는 이제 사이드 패널에" },
        line: { en: "The pane button shows how many are running.", ko: "패널 버튼에 실행 중인 수가 보여요." },
        show: "workers",
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
