// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Group } from "@/state/store";

const rooms = vi.hoisted(() => ({ remove: vi.fn(async () => ({ ok: true as const })) }));
vi.mock("@/lib/team-rooms", async (original) => ({
  ...await original<typeof import("@/lib/team-rooms")>(),
  removeFromRoom: rooms.remove,
  shareGroup: vi.fn(async () => ({ status: 0, error: "" })),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: {}, dispatch: () => undefined }),
}));

import { GroupPeople } from "./GroupPeople";

const group = { id: "g1", name: "Crew", threadId: "t1", memberIds: [], messages: [], hosted: { roomId: "r1" }, room: { name: "Crew", people: [{ id: "p1", name: "Mina" }] } } as unknown as Group;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rooms.remove.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label)!;

describe("Remove", () => {
  it("asks first and removes only on confirm", async () => {
    await act(async () => root.render(createElement(GroupPeople, { group })));
    await act(async () => button("Remove Mina").click());
    expect(rooms.remove).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent).toContain("Remove Mina?");
    await act(async () => button("Cancel").click());
    expect(rooms.remove).not.toHaveBeenCalled();
    await act(async () => button("Remove Mina").click());
    await act(async () => [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((candidate) => candidate.textContent === "Remove")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(rooms.remove).toHaveBeenCalledExactlyOnceWith("r1", "p1");
  });
});
