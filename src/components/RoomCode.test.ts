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
    expect(document.querySelector("[data-room-code-text]")).toBeNull();
  });

  it("shows the short code as selectable text when copy fails", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("navigator", { clipboard: undefined });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(createElement(RoomCode, { code: "long-code", short: "6LD5N6" })));
    await act(async () => document.querySelector<HTMLButtonElement>("[data-team-room-code] button")!.click());
    const text = document.querySelector("[data-room-code-text]")!;
    expect(text.textContent).toBe("6LD5N6");
    expect(text.className).toContain("select-all");
  });
});
