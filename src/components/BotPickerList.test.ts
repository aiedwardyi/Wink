// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { BotPickerList } from "./BotPickerList";

it("gives picked and unpicked bots the shared hover and keyboard focus surface", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onToggle = vi.fn();
  try {
    await act(async () => root.render(createElement(BotPickerList, {
      bots: [{ id: "b1", name: "Ada" }, { id: "b2", name: "Bo" }] as Bot[],
      picked: new Set(["b1"]), onToggle, emptyHint: "No bots",
    })));
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).toContain("hover:bg-control");
      expect(row.className).toContain("focus-visible:bg-control");
    }
    await act(async () => rows[1]!.click());
    expect(onToggle).toHaveBeenCalledWith("b2");
    expect(rows[0]!.getAttribute("aria-checked")).toBe("true");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
