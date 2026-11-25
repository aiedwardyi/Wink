import type { SwipeStep } from "@/lib/phone-swipe";

export type GlassScreen = "chat" | "check" | "models";
export type GlassFocus = "speak" | "header" | "listen" | "send" | "again" | "other";

export type GlassAction =
  | { type: "chat"; step: Exclude<SwipeStep, 0> }
  | { type: "reply"; dir: -1 | 1 }
  | { type: "messages" }
  | { type: "models" }
  | { type: "listen" }
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
    if (focus === "header") {
      if (key === "ArrowDown") return { type: "messages" };
      return key === "Enter" ? { type: "models" } : null;
    }
    if (focus === "listen") {
      if (key === "ArrowUp") return { type: "messages" };
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

export type ReplyPosition = { index: number; count: number; atTop: boolean; atBottom: boolean };
export type ReplyMove =
  | { type: "scroll"; dir: -1 | 1 }
  | { type: "message"; index: number; edge: "top" | "bottom" }
  | { type: "header" }
  | { type: "none" };

/** ArrowUp past a reply's top opens the older one at its end; past the oldest it reaches the model chip. ArrowDown walks back to the newest. */
export function replyMove(at: ReplyPosition, dir: -1 | 1): ReplyMove {
  if (dir < 0) {
    if (!at.atTop) return { type: "scroll", dir };
    return at.index > 0 ? { type: "message", index: at.index - 1, edge: "bottom" } : { type: "header" };
  }
  if (!at.atBottom) return { type: "scroll", dir };
  return at.index < at.count - 1 ? { type: "message", index: at.index + 1, edge: "top" } : { type: "none" };
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
