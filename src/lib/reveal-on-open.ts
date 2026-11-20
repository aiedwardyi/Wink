import { REVEALED_EVENT, STOP_FOLLOW_EVENT } from "./bottom-follow";
import { reducedMotion } from "./phone-swipe";

/** Ref for a box that opens under its button: scrolls it into view once it mounts, a no-op when it already shows. */
export function revealOnOpen(node: HTMLElement | null): void {
  node?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "instant" : "smooth" });
}

/** Ref for a box that opens under its button in a chat: the chat stops following its newest row and holds older rows until the
 * reader scrolls or the box closes, and the first time the box runs past the chat's edge, its top scrolls to the chat's top. */
export function revealInChat(node: HTMLElement | null): (() => void) | undefined {
  const chat = node?.closest<HTMLElement>("[data-orbit-transcript]");
  if (!node || !chat) return;
  node.dispatchEvent(new Event(STOP_FOLLOW_EVENT, { bubbles: true }));
  // Older rows loading right after landing shift the scroll by the bottom, which reads as the reader resuming follow.
  let held = true, reading = false, aiming = false;
  const release = () => {
    if (!held) return;
    held = false;
    sized.disconnect();
    for (const [target, type, on] of listeners) target.removeEventListener(type, on, { capture: true });
    chat.dispatchEvent(new Event(REVEALED_EVENT));
  };
  const read = () => (reading = true), rest = () => (reading = false), doc = chat.ownerDocument;
  // only a scroll during the reader's gesture hands the chat back: focus, layout and a swipe an inner scroller takes do not
  const listeners: [EventTarget, string, (e: Event) => void][] = [
    [doc, "wheel", read], [doc, "touchmove", read], [doc, "pointerdown", read], [doc, "keydown", read],
    [doc, "touchend", rest], [doc, "touchcancel", rest], [doc, "pointerup", rest],
    [chat, "scroll", (e) => e.target === chat && reading && release()],
    [chat, "scrollend", () => aiming && sized.disconnect()],
  ];
  // The box grows as its view loads, and a smooth scroll stops at the room there was when it began: re-aim until it lands.
  const sized = new ResizeObserver(() => {
    const box = node.getBoundingClientRect(), view = chat.getBoundingClientRect();
    if (!box.height || (box.top >= view.top && box.bottom <= view.bottom)) return;
    const top = Math.min(chat.scrollTop + box.top - view.top, chat.scrollHeight - chat.clientHeight);
    if (Math.abs(top - chat.scrollTop) < 1) return;
    aiming = true;
    chat.scrollTo({ top, behavior: reducedMotion() ? "instant" : "smooth" });
  });
  for (const [target, type, on] of listeners) target.addEventListener(type, on, { capture: true, passive: true });
  sized.observe(node);
  return release;
}
