import { STOP_FOLLOW_EVENT } from "./bottom-follow";
import { reducedMotion } from "./phone-swipe";

/** Ref for a box that opens under its button: scrolls it into view once it mounts, a no-op when it already shows. */
export function revealOnOpen(node: HTMLElement | null): void {
  node?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "instant" : "smooth" });
}

/** Ref for a box that opens under its button in a chat: the chat stops following its newest row, and the first time the box
 * runs past the chat's edge, its top scrolls to the chat's top, unless the reader scrolled first. */
export function revealInChat(node: HTMLElement | null): (() => void) | undefined {
  const chat = node?.closest<HTMLElement>("[data-orbit-transcript]");
  if (!node || !chat) return;
  node.dispatchEvent(new Event(STOP_FOLLOW_EVENT, { bubbles: true }));
  const done = () => {
    sized.disconnect();
    chat.removeEventListener("wheel", done);
    chat.removeEventListener("touchmove", done);
  };
  // The box grows as its view loads, so its first height is not its last: land it top first.
  const sized = new ResizeObserver(() => {
    const box = node.getBoundingClientRect(), view = chat.getBoundingClientRect();
    if (!box.height || (box.top >= view.top && box.bottom <= view.bottom)) return;
    done();
    chat.scrollBy({ top: box.top - view.top, behavior: reducedMotion() ? "instant" : "smooth" });
  });
  chat.addEventListener("wheel", done, { passive: true });
  chat.addEventListener("touchmove", done, { passive: true });
  sized.observe(node);
  return done;
}
