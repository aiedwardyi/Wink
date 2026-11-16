// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { faceWarms } from "./warm-faces";

afterEach(() => vi.restoreAllMocks());

it("lays out each first-session face in the document and leaves nothing behind", async () => {
  const laidOut: { className: string; text: string | null; attached: boolean; hidden: string }[] = [];
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    laidOut.push({ className: this.className, text: this.textContent, attached: this.isConnected, hidden: this.style.visibility });
    return 0;
  });
  for (const warm of faceWarms) await warm();
  expect(laidOut).toEqual([
    { className: "font-mono text-[11px]", text: "ABCD", attached: true, hidden: "hidden" },
    { className: "text-[16px]", text: "↵", attached: true, hidden: "hidden" },
    { className: "text-[12.5px] font-medium", text: "한국어", attached: true, hidden: "hidden" },
  ]);
  expect(document.body.childElementCount).toBe(0);
});
