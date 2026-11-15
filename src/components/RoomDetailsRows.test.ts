import "./ProfileFields.test-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import type { Action, Bot, Group, InstanceInfo } from "@/state/store";

const mock = vi.hoisted(() => ({
  dispatched: [] as Action[],
  voices: [{ id: "calm", label: "Calm", description: "Soft" }, { id: "bright", label: "Bright" }],
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: { tts: { configured: true, voice: "workspace" } } }, dispatch: (action: Action) => mock.dispatched.push(action) }),
  api: () => Promise.resolve({ voices: mock.voices }),
}));

import { WhoAnswersRow } from "./RoomDetailsRows";
import { NewBotRow } from "./GroupWizard";
import { VoiceSettings } from "./VoiceSettings";

const bots: Bot[] = ["Kai", "research Desk v2 / Seoul HQ"].map((name, index) => ({
  id: `b${index + 1}`, threadId: `t${index + 1}`, name, color: "green", title: "", description: "", notifications: true,
  unread: false, modelSelection: { instanceId: "codex", model: "fast" }, messages: [],
}));
const group: Group = { id: "g1", threadId: "gt1", name: "Studio", memberIds: ["b1", "b2"], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 0, messages: [] };
const instances: InstanceInfo[] = ["codex", "museAgent"].map((kind) => ({
  instanceId: kind, driverKind: kind, displayName: kind, snapshot: { state: "available", authenticated: true },
  models: { default: "fast", options: [{ id: "fast", label: "Fast" }, { id: "deep", label: "Deep" }] },
}));
let root: Root;
let host: HTMLDivElement;
const patches = vi.fn();
const trigger = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]:not([data-closing])');
const items = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
const key = (target: HTMLElement, value: string) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });
const open = (label: string) => act(async () => trigger(label).click());
const pick = async (label: string, index: number) => {
  await open(label);
  await act(async () => items()[index]!.click());
};
async function render(rowModel = "fast") {
  await act(async () => root.render(createElement(I18nProvider, null,
    createElement(WhoAnswersRow, { group, bots }),
    createElement(NewBotRow, { row: { key: 1, name: "Research", instanceId: "codex", model: rowModel, saving: false, error: null }, preferIndex: 0, instances, onPatch: patches, onAdd: vi.fn() }),
    createElement(VoiceSettings, { bot: { ...bots[0]!, voice: "saved" }, onPatch: patches }))));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  persistPreference("en");
  patches.mockClear();
  mock.dispatched.length = 0;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("replaces all four native selects with named Wink menu buttons", async () => {
  await render();
  expect(host.querySelectorAll("select")).toHaveLength(0);
  for (const label of ["Who answers", "Switch engine", "Change model", "Kai's voice"]) {
    expect(trigger(label)?.getAttribute("aria-haspopup")).toBe("menu");
  }
});

it("keeps every responder value and shows bot avatars, truncated names and the current check", async () => {
  await render();
  const responders = [{ kind: "everyone" }, { kind: "member", botId: "b1" }, { kind: "member", botId: "b2" }, { kind: "mentions" }];
  for (const [index, responder] of responders.entries()) {
    await open("Who answers");
    expect(items().map((item) => item.textContent)).toEqual(["Everyone responds", ...bots.map((bot) => bot.name), "Only @mentioned members"]);
    expect(items()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(items()[0]!.querySelector("svg.lucide-check")).not.toBeNull();
    expect(items()[1]!.querySelector('[role="img"], img')).not.toBeNull();
    expect(items()[2]!.querySelector(".truncate")?.textContent).toBe(bots[1]!.name);
    await act(async () => items()[index]!.click());
    if (index === 0) expect(mock.dispatched).toEqual([]);
    else expect(mock.dispatched.at(-1)).toEqual({ type: "patchGroup", groupId: "g1", patch: { defaultResponder: responder } });
    expect(document.activeElement).toBe(trigger("Who answers"));
  }
});

it("keeps every engine, model and voice patch, including workspace and missing saved voices", async () => {
  await render();
  for (const [index, instance] of instances.entries()) {
    await pick("Switch engine", index);
    if (index === 0) expect(patches).not.toHaveBeenCalled();
    else expect(patches).toHaveBeenLastCalledWith({ instanceId: instance.instanceId, model: null });
  }
  for (const [index, model] of ["fast", "deep"].entries()) {
    const before = patches.mock.calls.length;
    await pick("Change model", index);
    if (index === 0) expect(patches).toHaveBeenCalledTimes(before);
    else expect(patches).toHaveBeenLastCalledWith({ instanceId: "codex", model });
  }
  await open("Kai's voice");
  expect(items().map((item) => item.textContent)).toEqual(["Workspace Default", "Current Agent Voice", "Calm - Soft", "Bright"]);
  await key(items()[1]!, "Escape");
  for (const [index, voice] of ["", "saved", "calm", "bright"].entries()) {
    const before = patches.mock.calls.length;
    await pick("Kai's voice", index);
    if (voice === "saved") expect(patches).toHaveBeenCalledTimes(before);
    else expect(patches).toHaveBeenLastCalledWith({ voice });
  }
});

it("keeps current field choices without patches or a custom model reset", async () => {
  await render("deep");
  for (const label of ["Who answers", "Switch engine", "Change model", "Kai's voice"]) {
    await open(label);
    await act(async () => items().find((item) => item.getAttribute("aria-checked") === "true")!.click());
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger(label));
  }
  expect(patches).not.toHaveBeenCalled();
  expect(mock.dispatched).toEqual([]);
  expect(trigger("Change model").textContent).toBe("Deep");
});

it.each(["Who answers", "Switch engine", "Change model", "Kai's voice"])("dismisses %s without a patch and returns keyboard focus", async (label) => {
  await render();
  await key(trigger(label), "ArrowDown");
  expect(menu()).not.toBeNull();
  expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  await key(document.activeElement as HTMLElement, "ArrowDown");
  expect(document.activeElement).toBe(items()[(label === "Kai's voice" ? 2 : 1)]);
  await key(document.activeElement as HTMLElement, "Escape");
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(trigger(label));
  await open(label);
  await act(async () => document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })));
  expect(menu()).toBeNull();
  await open(label);
  await act(async () => menu()!.dispatchEvent(new Event("scroll")));
  expect(menu()).not.toBeNull();
  await act(async () => host.dispatchEvent(new Event("scroll")));
  expect(menu()).toBeNull();
  await open(label);
  await act(async () => window.dispatchEvent(new Event("scroll")));
  expect(menu()).toBeNull();
  expect(mock.dispatched).toEqual([]);
  expect(patches).not.toHaveBeenCalled();
});

it.each(["Who answers", "Switch engine", "Change model", "Kai's voice"])("keeps %s open while another pane scrolls", async (label) => {
  await render();
  const chat = document.body.appendChild(document.createElement("div"));
  await open(label);
  await act(async () => chat.dispatchEvent(new Event("scroll")));
  expect(menu()).not.toBeNull();
  await act(async () => host.dispatchEvent(new Event("scroll")));
  expect(menu()).toBeNull();
  chat.remove();
});

it("keeps a field menu open when the keyboard changes the window height, and closes it on a width change", async () => {
  await render();
  await open("Change model");
  const { innerWidth, innerHeight } = window;
  window.innerHeight = innerHeight + 300;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(menu()).not.toBeNull();
  window.innerWidth = innerWidth + 300;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(menu()).toBeNull();
  Object.assign(window, { innerWidth, innerHeight });
});

it("uses Enter once, keeps the wizard open on menu Escape and makes closing rows inert", async () => {
  await render();
  const escaped = vi.fn();
  host.addEventListener("keydown", escaped);
  await open("Change model");
  await key(items()[0]!, "End");
  await key(items()[1]!, "Enter");
  expect(patches).toHaveBeenCalledExactlyOnceWith({ model: "deep", instanceId: "codex" });
  expect(menu()).toBeNull();
  const closing = document.querySelector<HTMLElement>('[role="menu"][data-closing]');
  if (closing) expect(closing.inert).toBe(true);
  await open("Change model");
  escaped.mockClear();
  await key(items()[0]!, "Escape");
  expect(escaped).not.toHaveBeenCalled();
});
