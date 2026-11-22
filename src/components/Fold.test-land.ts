import { act } from "react";
import { vi } from "vitest";

export const spyReveal = () => vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);

/** Ends the open motion of the fold around `inside`, as the browser's animationend does. */
export async function landFold(inside: Element) {
  const end = new Event("animationend", { bubbles: true });
  Object.defineProperty(end, "animationName", { value: "fold-open" });
  await act(async () => inside.closest("[data-fold]")!.dispatchEvent(end));
}
