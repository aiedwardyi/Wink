// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Group } from "@/state/store";

const mock = vi.hoisted(() => ({ profile: undefined as { name?: string } | undefined }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: { profile: mock.profile } }, dispatch: vi.fn() }),
}));

import { HostPeople } from "./RoomDetailsPeople";

const group: Group = { id: "g1", threadId: "gt1", name: "Studio", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 0, messages: [] };
let root: Root;
let host: HTMLDivElement;
const ownRow = async (profile?: { name?: string }) => {
  mock.profile = profile;
  await act(async () => root.render(createElement(I18nProvider, null, createElement(HostPeople, { group }))));
  return host.querySelector("li")!;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("draws the person icon for an own row with no name, and still says Host", async () => {
  for (const profile of [undefined, { name: "" }]) {
    const row = await ownRow(profile);
    expect(row.querySelector("svg.lucide-user")).not.toBeNull();
    expect(row.textContent).toContain("Host");
  }
});

it("keeps initials for a named own row", async () => {
  const row = await ownRow({ name: "Mina Park" });
  expect(row.querySelector("svg.lucide-user")).toBeNull();
  expect(row.textContent).toContain("MP");
  expect(row.textContent).toContain("Mina Park");
});
