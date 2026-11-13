// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomCode } from "./RoomCode";

const LONG = `wkr1.${"x".repeat(120)}`;

let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mount(props: { code: string; short?: string }) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(createElement(RoomCode, props)));
  return document.querySelector<HTMLElement>("[data-team-room-code]")!;
}

describe("RoomCode", () => {
  it("shows the short code as one row of selectable text", async () => {
    const row = await mount({ code: LONG, short: "6LD5N6" });
    expect(row.children).toHaveLength(3);
    expect(row.querySelectorAll("span[aria-hidden]")).toHaveLength(0);
    const text = row.querySelector("[data-room-code-text]")!;
    expect(text.textContent).toBe("6LD5N6");
    expect(text.className).toContain("select-all");
  });

  it("keeps the short code selectable when copy fails", async () => {
    vi.stubGlobal("navigator", { clipboard: undefined });
    const row = await mount({ code: LONG, short: "6LD5N6" });
    await act(async () => row.querySelector("button")!.click());
    expect(row.querySelector("[data-room-code-text]")!.className).toContain("select-all");
  });

  it("truncates a long code in the row and copies all of it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const row = await mount({ code: LONG });
    expect(row.children).toHaveLength(3);
    const text = row.querySelector("[data-room-code-text]")!;
    expect(text.textContent).toBe(LONG);
    expect(text.className).toContain("truncate");
    await act(async () => row.querySelector("button")!.click());
    expect(writeText).toHaveBeenCalledWith(LONG);
  });

  it("unfolds a long code for hand selection when copy fails", async () => {
    vi.stubGlobal("navigator", { clipboard: undefined });
    const row = await mount({ code: LONG });
    await act(async () => row.querySelector("button")!.click());
    const text = row.querySelector("[data-room-code-text]")!;
    expect(text.className).toContain("select-all");
    expect(text.className).toContain("break-all");
    expect(text.className).not.toContain("truncate");
  });
});
