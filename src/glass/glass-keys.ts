import type { SwipeStep } from "@/lib/phone-swipe";

export type GlassScreen = "chat" | "check" | "models";
export type GlassFocus = "speak" | "ask" | "choice" | "bar" | "older" | "listen" | "send" | "again" | "other";

export type GlassAction =
  | { type: "chat"; step: Exclude<SwipeStep, 0> }
  | { type: "reply"; dir: -1 | 1 }
  | { type: "messages" }
  | { type: "older" }
  | { type: "ask"; dir: -1 | 1 }
  | { type: "choice"; dir: -1 | 1 }
  | { type: "answer" }
  | { type: "models" }
  | { type: "listen" }
  | { type: "toListen" }
  | { type: "toBar" }
  | { type: "model"; dir: -1 | 1 }
  | { type: "pick" }
  | { type: "composer" }
  | { type: "check" }
  | { type: "send" }
  | { type: "again" }
  | { type: "toSend" }
  | null;

/** One glasses key press. `text` says the focused field already holds what the system composer gave back. */
export function glassKey(screen: GlassScreen, focus: GlassFocus, key: string, text = false): GlassAction {
  if (screen === "chat") {
    if (key === "ArrowLeft" || key === "ArrowRight") return { type: "chat", step: key === "ArrowLeft" ? -1 : 1 };
    if (focus === "older") {
      if (key === "ArrowDown") return { type: "messages" };
      return key === "Enter" ? { type: "older" } : null;
    }
    if (focus === "ask") return key === "ArrowUp" || key === "ArrowDown" ? { type: "ask", dir: key === "ArrowUp" ? -1 : 1 } : null;
    if (focus === "choice") {
      if (key === "ArrowUp" || key === "ArrowDown") return { type: "choice", dir: key === "ArrowUp" ? -1 : 1 };
      return key === "Enter" ? { type: "answer" } : null;
    }
    if (focus === "bar") {
      if (key === "ArrowUp") return { type: "messages" };
      if (key === "ArrowDown") return { type: "toListen" };
      return key === "Enter" ? { type: "models" } : null;
    }
    if (focus === "listen") {
      if (key === "ArrowUp") return { type: "toBar" };
      return key === "Enter" ? { type: "listen" } : null;
    }
    if (key === "ArrowUp" || key === "ArrowDown") return { type: "reply", dir: key === "ArrowUp" ? -1 : 1 };
    if (key === "Enter" && focus === "speak") return text ? { type: "check" } : { type: "composer" };
    return null;
  }
  if (screen === "models") {
    if (key === "ArrowUp" || key === "ArrowDown") return { type: "model", dir: key === "ArrowUp" ? -1 : 1 };
    return key === "Enter" ? { type: "pick" } : null;
  }
  if (key === "ArrowLeft" || key === "ArrowDown") return { type: "again" };
  if (key === "ArrowRight" || key === "ArrowUp") return { type: "toSend" };
  if (key !== "Enter") return null;
  if (focus === "send") return { type: "send" };
  if (focus === "again") return text ? { type: "check" } : { type: "composer" };
  return null;
}

export type ReplyPosition = { index: number; count: number; atTop: boolean; atBottom: boolean; older: boolean; ask?: boolean; askFirst?: boolean };
export type ReplyMove =
  | { type: "scroll"; dir: -1 | 1 }
  | { type: "message"; index: number }
  | { type: "older" }
  | { type: "ask" }
  | { type: "bar" }
  | { type: "none" };

/** Replies open at their start. A key scrolls inside one first; past its top ArrowUp opens the older one, past the oldest shown it reaches "See 10 more"; past the newest ArrowDown reaches the bot's open question, then the model bar. An open question takes the newest reply's first ArrowDown; after ArrowUp from it, ArrowDown reads the reply through. */
export function replyMove(at: ReplyPosition, dir: -1 | 1): ReplyMove {
  if (dir < 0) {
    if (!at.atTop) return { type: "scroll", dir };
    if (at.index > 0) return { type: "message", index: at.index - 1 };
    return at.older ? { type: "older" } : { type: "none" };
  }
  if (at.askFirst && at.index === at.count - 1) return { type: "ask" };
  if (!at.atBottom) return { type: "scroll", dir };
  if (at.index < at.count - 1) return { type: "message", index: at.index + 1 };
  return at.ask ? { type: "ask" } : { type: "bar" };
}

/** Where a key on a question's choices goes: the next choice, the question above the first, the bar below the last. */
export function choiceMove(index: number, count: number, dir: -1 | 1): { type: "choice"; index: number } | { type: "ask" } | { type: "bar" } {
  const next = index + dir;
  if (next < 0) return { type: "ask" };
  return next < count ? { type: "choice", index: next } : { type: "bar" };
}

/** How far a key scrolls the choices first: a focused choice taller than its box shows its rest before the key moves on (0). */
export function choiceScroll(box: { top: number; bottom: number }, choice: { top: number; bottom: number }, dir: -1 | 1, step: number): number {
  const past = dir < 0 ? box.top - choice.top : choice.bottom - box.bottom;
  return past > 1 ? dir * Math.min(past, step) : 0;
}

/** Replies a "See more" step adds. */
export const OLDER_STEP = 10;

/** How many of the newest replies Up can reach, and whether "See more" sits past them. */
export function olderWindow(count: number, limit: number, hasMore: boolean) {
  return { first: Math.max(0, count - limit), older: count > limit || hasMore };
}

/** Lines scrolled past the top, plus the one under the "lines above" cue. */
export function linesAbove(scrollTop: number, lineHeight: number): number {
  return scrollTop > 0 ? Math.round(scrollTop / lineHeight) + 1 : 0;
}

const SPOKEN_DIGITS = new Map(Object.entries({
  zero: "0", oh: "0", o: "0",
  one: "1", won: "1",
  two: "2", to: "2", too: "2",
  three: "3",
  four: "4", for: "4",
  five: "5", six: "6", seven: "7",
  eight: "8", ate: "8",
  nine: "9",
}));

/** Dictation may return "482917", "4 8 2 9 1 7" or "four eight two nine one seven"; other words drop out. Mirrored in public/pair.html. */
export function spokenDigits(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => (/^\d+$/.test(word) ? word : (SPOKEN_DIGITS.get(word) ?? "")))
    .join("");
}
