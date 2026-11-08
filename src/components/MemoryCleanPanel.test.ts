// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { initialState, reducer, type Bot } from "@/state/store";
import { SettingsPanel } from "./SettingsPanel";

const mock = vi.hoisted(() => ({ state: {} as typeof initialState, dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => mock }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: "other" }, localComputer: { available: false } }, ready: true }) }));
vi.mock("./BotProfileAvatarCard", () => ({ BotProfileAvatarCard: () => null }));
vi.mock("./VoiceSettings", () => ({ VoiceSettings: () => null }));
const bot: Bot = { id: "b", threadId: "t", name: "Atlas", title: "", description: "", color: "blue", unread: false, notifications: false, modelSelection: { instanceId: "i", model: "m" }, messages: [{ id: "s", role: "bot", kind: "activity", at: 1, tool: { name: "memory.save", spoken: "Seoul", lines: ["- Seoul"] } }] };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
// the map is a lazy chunk
async function until(found: () => Element | null | undefined) {
  for (let tries = 0; tries < 100 && !found(); tries++) await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  return found();
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); applyLocale("en"); vi.unstubAllGlobals(); });

describe("Memory tab targets", () => {
  it.each(["en", "ko"] as const)("opens, scrolls and replays the target in %s", async (locale) => {
    applyLocale(locale); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async (path) => Response.json(String(path).endsWith("/clean") ? { run: null } : { text: "- Seoul", topics: [], revision: "r", truncated: false })));
    const scroll = vi.fn(); HTMLElement.prototype.scrollIntoView = scroll;
    HTMLElement.prototype.scrollTo = vi.fn();
    mock.state = reducer({ ...initialState, bots: [bot] }, { type: "toggleSettings", open: true, memory: { line: "- Seoul" } });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(createElement(SettingsPanel, { bot })));
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(locale === "en" ? "Memory" : "메모리");
    const first = await until(() => host.querySelector(".mc-tint")); expect(first).not.toBeNull();
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
    mock.state = reducer(mock.state, { type: "toggleSettings", open: true, memory: { line: "- Seoul" } });
    await act(async () => root.render(createElement(SettingsPanel, { bot })));
    expect(host.querySelector(".mc-tint")).not.toBe(first);
    expect(scroll).toHaveBeenCalledTimes(2);
  });
  it("rereads a save made while the Settings tab was open", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let text = "- Earlier";
    vi.stubGlobal("fetch", vi.fn(async (path) => Response.json(String(path).endsWith("/clean") ? { run: null } : { text, topics: [], revision: "r", truncated: false })));
    HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.scrollTo = vi.fn();
    mock.state = { ...initialState, bots: [bot], settingsOpen: true };
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(createElement(SettingsPanel, { bot })));
    text = "- Seoul";
    mock.state = reducer(mock.state, { type: "toggleSettings", open: true, memory: { line: "- Seoul" } });
    await act(async () => root.render(createElement(SettingsPanel, { bot })));
    expect((await until(() => host.querySelector(".mc-tint")))?.parentElement?.textContent).toContain("Seoul");
  });

});
