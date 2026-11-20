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
  const landed = () => {
    sized.disconnect();
    chat.removeEventListener("scrollend", landed);
  };
  // Older rows loading right after landing shift the scroll by the bottom, which reads as the reader resuming follow.
  let held = true;
  const release = (e?: Event) => {
    // a gesture on the box scrolls the box, not the chat
    if (!held || (e?.target instanceof Node && node.contains(e.target))) return;
    held = false;
    landed();
    chat.removeEventListener("wheel", release);
    chat.removeEventListener("touchmove", release);
    chat.dispatchEvent(new Event(REVEALED_EVENT));
  };
  // The box grows as its view loads, and a smooth scroll stops at the room there was when it began: re-aim until it lands.
  const sized = new ResizeObserver(() => {
    const box = node.getBoundingClientRect(), view = chat.getBoundingClientRect();
    if (!box.height || (box.top >= view.top && box.bottom <= view.bottom)) return;
    const instant = reducedMotion();
    chat.scrollTo({ top: chat.scrollTop + box.top - view.top, behavior: instant ? "instant" : "smooth" });
    if (instant) landed();
    else chat.addEventListener("scrollend", landed);
  });
  chat.addEventListener("wheel", release, { passive: true });
  chat.addEventListener("touchmove", release, { passive: true });
  sized.observe(node);
  return release;
}
