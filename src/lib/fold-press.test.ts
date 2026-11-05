// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { afterFold } from "./fold-press";

afterEach(() => document.body.replaceChildren());

function fold(animations: Pick<Animation, "playState" | "finished">[]) {
  const element = document.createElement("div");
  element.id = "fold";
  element.getAnimations = () => animations as Animation[];
  document.body.append(element);
}

describe("afterFold", () => {
  it("toggles at once when the fold is still or missing", () => {
    const toggle = vi.fn();
    afterFold("fold", toggle);
    fold([{ playState: "finished", finished: Promise.resolve() as unknown as Animation["finished"] }]);
    afterFold("fold", toggle);
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it("waits for a running fold motion, so a fast double press does not jump", async () => {
    let end!: () => void;
    const finished = new Promise<void>((resolve) => { end = resolve; }) as unknown as Animation["finished"];
    fold([{ playState: "running", finished }]);
    const toggle = vi.fn();
    afterFold("fold", toggle);
    await Promise.resolve();
    expect(toggle).not.toHaveBeenCalled();
    end();
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledTimes(1));
  });

  it("still toggles when the motion is cut short", async () => {
    fold([{ playState: "running", finished: Promise.reject(new DOMException("cancelled", "AbortError")) as Animation["finished"] }]);
    const toggle = vi.fn();
    afterFold("fold", toggle);
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledTimes(1));
  });
});
