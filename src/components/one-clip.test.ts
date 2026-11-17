// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThumb } from "@/lib/media-thumbs";
import { MediaClip } from "./MediaClip";
import { MediaViewer } from "./MediaViewer";
import { PhoneVideo } from "./PhoneVideo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/media-thumbs", () => ({ useThumb: vi.fn() }));

function playing(video: HTMLVideoElement) {
  vi.spyOn(video, "paused", "get").mockReturnValue(false);
  vi.spyOn(video, "pause");
}

const hosts: HTMLElement[] = [];
const roots: Root[] = [];

async function render(element: ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return host;
}

const firePlay = (video: HTMLVideoElement) => act(async () => { video.dispatchEvent(new Event("play")); });

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("one clip at a time", () => {
  it("pauses the first chat clip when a second one starts", async () => {
    const host = await render(createElement("div", null,
      createElement(PhoneVideo, { src: "a.mp4" }),
      createElement(PhoneVideo, { src: "b.mp4" })));
    const [first, second] = [...host.querySelectorAll("video")];
    playing(first!);
    vi.spyOn(second!, "pause");
    await firePlay(first!);
    expect(first!.pause).not.toHaveBeenCalled();
    await firePlay(second!);
    expect(first!.pause).toHaveBeenCalledOnce();
    expect(second!.pause).not.toHaveBeenCalled();
  });

  it("pauses the viewer video when a chat clip starts", async () => {
    await render(createElement(MediaViewer, { image: { src: "v.mp4", name: "v", video: true }, onClose: () => {} }));
    const viewer = document.querySelector<HTMLVideoElement>("[data-media-viewer] video")!;
    playing(viewer);
    const chat = await render(createElement(PhoneVideo, { src: "c.mp4" }));
    await firePlay(chat.querySelector("video")!);
    expect(viewer.pause).toHaveBeenCalledOnce();
  });

  it("a hover preview does not pause a playing chat clip", async () => {
    vi.mocked(useThumb).mockReturnValue("blob:poster");
    const chat = await render(createElement(PhoneVideo, { src: "c.mp4" }));
    const phone = chat.querySelector("video")!;
    playing(phone);
    const tile = await render(createElement(MediaClip, { src: "hover.mp4", name: "hover", children: "tile" }));
    await act(async () => { tile.firstElementChild!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(tile.querySelector("video")).not.toBeNull();
    expect(phone.pause).not.toHaveBeenCalled();
  });
});
