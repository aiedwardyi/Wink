// Prototype copy, en + ko. Short plain facts, about 5 words a line.
// The build moves these into src/lib/i18n-catalog.ts.
import { useI18n } from "@/lib/i18n";
import { ZONE } from "./fixtures";

const EN = {
  left: "left",
  inUse: "In use",
  working: "{n} working",
  idle: "Idle",
  lasts: "Lasts to reset",
  runsOut: "Runs out ~{time}",
  out: "Out",
  back: "Back {time}",
  resets: "Resets {time}",
  noData: "Shows after first message",
  ranOut: "{from} ran out. Using {to}.",
  youMoved: "You picked {to}.",
  use: "Use {n}",
  stayOn: "Stay on {n}",
  stayingOn: "Staying on {n}",
  then: "Then {to}",
  noMoves: "No automatic moves",
  allUsage: "All usage",
  fiveHour: "5h",
  week: "Week",
  todayVs: "Today {x}× normal",
  todayLess: "Quieter than normal",
  todayNormal: "A normal day",
  normal: "normal",
  est: "est.",
  usage: "Usage",
  settings: "Settings",
  done: "Done",
  waitTitle: "{name} is out.",
  waitBack: "Back {time}.",
  cancel: "Cancel",
  name: "Name",
  switching: "Switching…",
  leftAria: "{name}: {pct}% left",
  openAria: "Usage: {name}, {pct}% left",
  onIt: "On it now",
  addAccount: "Add Account",
  signOut: "Sign Out",
  more: "More",
} as const;

type Key = keyof typeof EN;

const KO: Record<Key, string> = {
  left: "남음",
  inUse: "사용 중",
  working: "{n}개 작업 중",
  idle: "대기",
  lasts: "초기화까지 충분",
  runsOut: "{time}쯤 소진",
  out: "소진",
  back: "{time} 복귀",
  resets: "{time} 초기화",
  noData: "첫 메시지 후 표시",
  ranOut: "{from} 한도 소진. {to} 사용 중.",
  youMoved: "{to} 직접 선택.",
  use: "{n} 사용",
  stayOn: "{n}만 사용",
  stayingOn: "{n}만 사용 중",
  then: "이후 {to}",
  noMoves: "자동 전환 안 함",
  allUsage: "전체 사용량",
  fiveHour: "5시간",
  week: "주간",
  todayVs: "오늘 평소의 {x}배",
  todayLess: "평소보다 한가함",
  todayNormal: "평소 수준",
  normal: "평소",
  est: "추정",
  usage: "사용량",
  settings: "설정",
  done: "완료",
  waitTitle: "{name} 한도 소진.",
  waitBack: "{time} 복귀.",
  cancel: "취소",
  name: "이름",
  switching: "전환 중…",
  leftAria: "{name}: {pct}% 남음",
  openAria: "사용량: {name}, {pct}% 남음",
  onIt: "지금 사용 중",
  addAccount: "계정 추가",
  signOut: "로그아웃",
  more: "더 보기",
};

const fill = (text: string, vars?: Record<string, string | number>) =>
  vars ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? "")) : text;

export type DeskT = (key: Key, vars?: Record<string, string | number>) => string;

export function useDeskText() {
  const { locale } = useI18n();
  const ko = locale === "ko";
  const t: DeskT = (key, vars) => fill(ko ? KO[key] : EN[key], vars);
  const tag = ko ? "ko-KR" : "en-US";
  const clock = new Intl.DateTimeFormat(tag, { hour: "numeric", minute: "2-digit", timeZone: ZONE });
  const dayClock = new Intl.DateTimeFormat(tag, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: ZONE });
  const weekday = new Intl.DateTimeFormat(tag, { weekday: "short", timeZone: ZONE });
  const dayKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ZONE });
  const sameDay = (a: number, b: number) => dayKey.format(a) === dayKey.format(b);
  /** "3:52 PM" today, "Mon 5:00 PM" on another day. */
  const when = (time: number, now: number) => (sameDay(time, now) ? clock : dayClock).format(time);
  const span = (ms: number) => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    if (d > 0) return ko ? `${d}일 ${h}시간` : `${d}d ${h}h`;
    if (h > 0) return ko ? `${h}시간 ${m}분` : `${h}h ${m}m`;
    return ko ? `${m}분` : `${m}m`;
  };
  /** Live countdown: seconds only in the last hour. */
  const countdown = (ms: number) => {
    if (ms >= 3_600_000) return span(ms);
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return { t, ko, clock: (time: number) => clock.format(time), when, weekday: (time: number) => weekday.format(time), span, countdown, sameDay };
}

export type DeskText = ReturnType<typeof useDeskText>;
