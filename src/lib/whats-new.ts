import memoryClip from "@/assets/whats-new/1.0.246-memory.webp";
import memoryLightClip from "@/assets/whats-new/1.0.246-memory-light.webp";
import verifyClip from "@/assets/whats-new/1.0.246-verify.webp";
import hydrogenClip from "@/assets/whats-new/1.0.263-hydrogen.webp";
import hydrogenLightClip from "@/assets/whats-new/1.0.263-hydrogen-light.webp";
import mapClip from "@/assets/whats-new/1.0.263-map.webp";
import mapLightClip from "@/assets/whats-new/1.0.263-map-light.webp";
import themesClip from "@/assets/whats-new/1.0.276-themes.webp";
import dialClip from "@/assets/whats-new/1.0.277-dial.webp";
import workersClip from "@/assets/whats-new/1.0.278-workers.webp";
import timelineClip from "@/assets/whats-new/1.0.282-timeline.webp";
import timelineLightClip from "@/assets/whats-new/1.0.282-timeline-light.webp";
import forumClip from "@/assets/whats-new/1.0.282-forum.webp";
import forumLightClip from "@/assets/whats-new/1.0.282-forum-light.webp";
import picksClip from "@/assets/whats-new/1.0.287-timeline.webp";
import forumFirstClip from "@/assets/whats-new/1.0.287-forum.webp";
import paneClip from "@/assets/whats-new/1.0.302-pane.mp4";
import quickClip from "@/assets/whats-new/1.0.303-quick.mp4";
import quickMotionClip from "@/assets/whats-new/1.0.304-quick.mp4";
import { newerRelease } from "../../shared/release-order";
import type { LocaleId } from "./i18n";
import type { SkinId } from "./skins";

type Copy = Record<LocaleId, string>;

/** What Show me opens in this chat. */
export type WhatsNewTarget = "memory" | "map" | "models" | "workers" | "timeline" | "forum" | "pane" | "quick" | { skins: SkinId[] };

/** Every tile after 1.0.278 is a moving clip plus a Show me that opens the feature; whats-new.test.ts enforces it. `how` and `still` only keep older tiles as they shipped. */
export type WhatsNewTile = { clip: string; lightClip?: string; still?: true; title: Copy; line: Copy } & ({ show: WhatsNewTarget } | { how: Copy });

export type WhatsNewEntry = { title: Copy; tiles: [WhatsNewTile] | [WhatsNewTile, WhatsNewTile]; more: Copy };

/** A release that chose to ship no tile; the release gate (scripts/check-whats-new.mjs) accepts it in place of tiles. */
export type WhatsNewNone = { tile: "none"; reason: string };

const themesTile: WhatsNewTile = {
  clip: themesClip,
  title: { en: "Four new themes that move", ko: "움직이는 새 테마 4개" },
  line: { en: "Samurai Ink, Night Rain, Warp and Circuit.", ko: "사무라이 잉크, 나이트 레인, 워프, 서킷." },
  show: { skins: ["samurai-ink", "night-rain", "warp", "circuit"] },
};

// One entry per release that has notes; a release with no entry shows the newest earlier one still unseen.
export const RELEASE_NOTES: Record<string, WhatsNewEntry | WhatsNewNone> = {
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
        how: {
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
  "1.0.279": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.280": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.281": { tile: "none", reason: "GPT-6.2 models and fixes; Timeline and Forum tiles come in the next update." },
  "1.0.282": {
    title: { en: "New in Wink 1.0.282", ko: "Wink 1.0.282 새 기능" },
    tiles: [
      {
        clip: timelineClip,
        lightClip: timelineLightClip,
        title: { en: "Your bot's decisions, on a Timeline", ko: "봇의 결정을 타임라인으로" },
        line: { en: "Every pick, with the pictures behind it.", ko: "선택마다 그 근거가 된 그림과 함께." },
        show: "timeline",
      },
      {
        clip: forumClip,
        lightClip: forumLightClip,
        title: { en: "Bots help each other in the Forum", ko: "포럼에서 봇끼리 서로 도와요" },
        line: { en: "They post when stuck. Your chat stays out.", ko: "막히면 글을 올려요. 내 대화는 빠져요." },
        show: "forum",
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.283": { tile: "none", reason: "Speed and fixes; no feature tile this release." },
  "1.0.284": { tile: "none", reason: "Speed and fixes; no feature tile this release." },
  "1.0.285": { tile: "none", reason: "Forum redesign, speed and fixes; no feature tile this release." },
  "1.0.286": { tile: "none", reason: "Gemini 4 Neon and a fix; no feature tile this release." },
  "1.0.287": {
    title: { en: "New in Wink 1.0.287", ko: "Wink 1.0.287 새 기능" },
    tiles: [
      {
        clip: picksClip,
        title: { en: "Your decisions land on the Timeline", ko: "내 결정이 타임라인에 남아요" },
        line: { en: "Pick in a chat; it shows up here.", ko: "대화에서 고르면 여기에 보여요." },
        show: "timeline",
      },
      {
        clip: forumFirstClip,
        title: { en: "Bots check the Forum first", ko: "봇이 포럼부터 확인해요" },
        line: { en: "They share fixes and look there before asking you.", ko: "해결책을 나누고, 묻기 전에 먼저 찾아봐요." },
        show: "forum",
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.288": { tile: "none", reason: "Launch-day fixes; no feature tile this release." },
  "1.0.289": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.290": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.291": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.292": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.293": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.294": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.295": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.296": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.297": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.298": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.299": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.300": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.301": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.302": {
    title: { en: "New in Wink 1.0.302", ko: "Wink 1.0.302 새 기능" },
    tiles: [
      {
        clip: paneClip,
        title: { en: "Side pane tabs", ko: "사이드 패널 탭" },
        line: { en: "Open only the tabs you need. Drag to reorder, drag the edge to resize.", ko: "필요한 탭만 열어요. 끌어서 순서를 바꾸고, 가장자리를 끌어 크기를 조절해요." },
        show: "pane",
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.303": {
    title: { en: "New in Wink 1.0.303", ko: "Wink 1.0.303 새 기능" },
    tiles: [
      {
        clip: quickClip,
        title: { en: "Quick model picker", ko: "빠른 모델 선택" },
        line: { en: "A fourth picker style: pick model and effort in one step. Max glows in the model's color.", ko: "네 번째 선택 방식: 모델과 추론 강도를 한 번에 골라요. 최대로 고르면 모델 색으로 빛나요." },
        show: "quick",
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.304": {
    title: { en: "New in Wink 1.0.304", ko: "Wink 1.0.304 새 기능" },
    tiles: [
      {
        clip: quickMotionClip,
        title: { en: "Quick model picker", ko: "빠른 모델 선택" },
        line: { en: "A fourth picker style: pick model and effort in one step. Max glows in the model's color.", ko: "네 번째 선택 방식: 모델과 추론 강도를 한 번에 골라요. 최대로 고르면 모델 색으로 빛나요." },
        show: "quick",
      },
    ],
    more: { en: "And more in the release notes", ko: "그 밖의 변경은 릴리스 노트에서" },
  },
  "1.0.305": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.306": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.307": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.308": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
  "1.0.309": { tile: "none", reason: "Fixes and polish; no feature tile this release." },
};

/** The releases with tiles; a no-tile record has nothing to show. */
export const tilesOnly = (list: Record<string, WhatsNewEntry | WhatsNewNone>) =>
  Object.fromEntries(Object.entries(list).filter((pair): pair is [string, WhatsNewEntry] => "tiles" in pair[1]));

export const WHATS_NEW = tilesOnly(RELEASE_NOTES);

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