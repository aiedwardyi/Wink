// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot, Group } from "@/state/store";

vi.mock("@/lib/usage-auto-refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/usage-auto-refresh")>()),
  useAutoRefresh: () => undefined,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { bots: [], config: {} }, dispatch: () => {} }),
}));

import { I18nProvider } from "@/lib/i18n";
import { endCall, startCall } from "@/lib/call";
import { CallButton } from "./CallView";
import { CallVoicePicker } from "./CallVoicePicker";
import { GroupCallOverlay } from "./GroupCallView";

const bot = { id: "bot-1", name: "Ada", color: "#7c3aed", messages: [] } as unknown as Bot;
const group = { id: "room-1", name: "Room", messages: [] } as unknown as Group;

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  endCall();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, element)));
  return host;
}

it("gives the call help popover the app menu surface", async () => {
  const host = await render(createElement(CallButton, { bot }));
  const button = host.querySelector<HTMLButtonElement>("button[aria-controls]")!;
  await act(async () => button.click());
  const help = document.getElementById(button.getAttribute("aria-controls")!)!;
  expect(help.classList).toContain("bg-card");
  expect(help.classList).toContain("border-hairline/50");
  expect(help.classList).not.toContain("bg-panel");
});

it("leaves voice picker focus to the global ring and snaps its hovers", async () => {
  const host = await render(createElement(CallVoicePicker));
  const voices = [...host.querySelectorAll('[role="radiogroup"]')].find((group) => group.querySelector("button[aria-pressed]"))!;
  const buttons = [...voices.querySelectorAll("button")];
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) expect([...button.classList].filter((value) => /^(focus-visible:outline|transition-colors$)/.test(value))).toEqual([]);
});

it("moves the focused group call tile on the default duration", async () => {
  await act(async () => startCall(group.id));
  const host = await render(createElement(GroupCallOverlay, { group, members: [bot] }));
  const tile = host.querySelector(".w-\\[124px\\]")!;
  expect(tile).not.toBeNull();
  expect([...tile.classList].filter((value) => value.startsWith("duration-"))).toEqual([]);
});
