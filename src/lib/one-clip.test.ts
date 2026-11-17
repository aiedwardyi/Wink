// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { pauseOtherClips } from "./one-clip";

function clip(playing: boolean) {
  const video = document.createElement("video");
  document.body.append(video);
  vi.spyOn(video, "paused", "get").mockReturnValue(!playing);
  vi.spyOn(video, "pause");
  return video;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("pauseOtherClips", () => {
  it("pauses the first clip when a second one starts", () => {
    const first = clip(true);
    const second = clip(true);
    pauseOtherClips(second);
    expect(first.pause).toHaveBeenCalledOnce();
    expect(second.pause).not.toHaveBeenCalled();
  });

  it("leaves paused clips and the starting clip alone", () => {
    const idle = clip(false);
    const next = clip(true);
    const starting = clip(true);
    pauseOtherClips(starting);
    expect(next.pause).toHaveBeenCalledOnce();
    expect(idle.pause).not.toHaveBeenCalled();
    expect(starting.pause).not.toHaveBeenCalled();
  });

  it("ignores clips no longer on the page", () => {
    const left = clip(true);
    left.remove();
    const starting = clip(true);
    pauseOtherClips(starting);
    expect(left.pause).not.toHaveBeenCalled();
  });
});
