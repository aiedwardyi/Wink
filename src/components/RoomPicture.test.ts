// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { RoomPicture } from "./RoomPicture";

let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("tries the picture again once the host is back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(createElement(RoomPicture, { src: "/p.png", retry: "offline" })));
  await act(async () => document.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(document.querySelector("img")).toBeNull();
  await act(async () => root!.render(createElement(RoomPicture, { src: "/p.png", retry: "live" })));
  expect(document.querySelector("img")?.getAttribute("src")).toBe("/p.png");
});
