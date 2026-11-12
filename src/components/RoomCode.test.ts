// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomCode } from "./RoomCode";

let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("RoomCode", () => {
  it("keeps the shown short code from text-selecting", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(createElement(RoomCode, { code: "long-code", short: "6LD5N6" })));
    const boxes = document.querySelector("[data-room-short-code]")!;
    expect(boxes.children).toHaveLength(6);
    expect(boxes.className).toContain("select-none");
    expect(boxes.className).not.toContain("select-all");
  });
});
