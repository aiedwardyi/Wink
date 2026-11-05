import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";
import { SIDEBAR_COLLAPSED_KEY, SIDEBAR_COLLAPSED_SECTIONS_KEY, SIDEBAR_ORDER_KEY } from "@/lib/sidebar-preferences";
import { LONG_PRESS_MS } from "@/lib/use-touch-drag";
import { StoreProvider } from "@/state/store";

import { Sidebar } from "./Sidebar";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });

vi.mock("@/lib/updater", () => ({
  useUpdaterState: () => null,
  useManualCheck: () => ({ acknowledged: true, check: () => undefined }),
}));

class FakeEventSource {
  static current: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() { FakeEventSource.current = this; }
}

const bot = (id: string, section = "Work", pinned = false) => ({
  id, threadId: `${id}-thread`, name: id, section, pinned, messages: [], modelSelection: { instanceId: "", model: "" },
});
const group = (id = "team", pinned = false, section = "Work") => ({
  id, threadId: `${id}-thread`, name: id, section, pinned, memberIds: ["regular"],
  defaultResponder: { kind: "everyone" }, bulletin: "", createdAt: 0, messages: [], unread: false,
});
let root: Root | null = null;

async function mount(groups = [group()], bots: Array<ReturnType<typeof bot> & { chiefOfStaff?: boolean }> = [bot("regular")]) {
  let serverGroups = groups;
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/bots?messages=200") return new Response(JSON.stringify({ bots, groups: serverGroups }));
    if (path.startsWith("/api/groups/") && init?.method === "PATCH") {
      const id = path.slice("/api/groups/".length);
      const patch = JSON.parse(String(init.body));
      calls.push({ path, method: init.method, body: patch });
      serverGroups = serverGroups.map((g) => g.id === id ? { ...g, ...patch } : g);
      return new Response(JSON.stringify({ group: serverGroups.find((g) => g.id === id) }));
    }
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null,
    createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => undefined })),
  )));
  await act(async () => FakeEventSource.current.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }), lastEventId: "" }));
  await vi.waitFor(() => expect(host.querySelector("[data-sidebar-row]")).not.toBeNull());
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-sidebar-row-id="${id}"]`)!;
  const menu = async (id = "team") => {
    await act(async () => row(id).querySelector("button")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 })));
    return document.querySelector<HTMLElement>("[data-room-menu]:not([data-closing])")!;
  };
  return { host, calls, row, menu };
}

async function clickMenu(menu: HTMLElement, label: string) {
  const button = [...menu.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await vi.waitFor(() => expect(document.querySelector("[data-room-menu]")).toBeNull());
}

const savedOrder = () => JSON.parse(localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "{}").itemOrder;
const fireDrag = (target: Element, type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => "", setData: () => undefined } });
  target.dispatchEvent(event);
};

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
  persistPreference("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("group pins in the sidebar", () => {
  it.each([
    ["en", false, "Pin"], ["en", true, "Unpin"], ["ko", false, "고정"], ["ko", true, "고정 해제"],
  ] as const)("shows %s pinned=%s as %s", async (locale, pinned, label) => {
    persistPreference(locale);
    const { menu } = await mount([group("team", pinned)]);
    expect((await menu()).querySelector("button")?.textContent).toBe(label);
  });

  it("PATCHes true and false without changing the saved section slot", async () => {
    localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify({ sectionOrder: ["section:Work"], itemOrder: { "section:Work": ["bot:regular", "group:team", "bot:last"] } }));
    const { host, calls, menu } = await mount([group()], [bot("regular"), bot("last")]);
    const before = savedOrder();
    await clickMenu(await menu(), "Pin");
    expect(calls).toContainEqual({ path: "/api/groups/team", method: "PATCH", body: { pinned: true } });
    expect(host.querySelector('[data-sidebar-priority-tier="pinned"] [data-sidebar-row-id="team"]')).not.toBeNull();
    expect(savedOrder()).toEqual(before);
    await clickMenu(await menu(), "Unpin");
    expect(calls).toContainEqual({ path: "/api/groups/team", method: "PATCH", body: { pinned: false } });
    expect(savedOrder()).toEqual(before);
    expect([...host.querySelectorAll('[data-sidebar-section-id="section:Work"] [data-sidebar-row]')].map((r) => r.getAttribute("data-sidebar-row-id"))).toEqual(["regular", "team", "last"]);
  });

  it("renders a pinned group with the pin icon between chief and sections", async () => {
    const { host, row } = await mount([group("team", true)], [{ ...bot("chief"), chiefOfStaff: true }, bot("pinned", "Work", true), bot("regular")]);
    const tier = host.querySelector('[data-sidebar-priority-tier="pinned"]');
    expect(tier?.contains(row("team"))).toBe(true);
    expect(tier?.contains(row("pinned"))).toBe(true);
    expect(row("team").querySelector("svg.lucide-pin")).not.toBeNull();
    expect([...host.querySelectorAll("[data-sidebar-priority-tier], [data-sidebar-section-id]")].map((el) => el.getAttribute("data-sidebar-priority-tier") ?? el.getAttribute("data-sidebar-section-id"))).toEqual(["chief", "pinned", "section:Work"]);
  });

  it.each([false, true])("keeps a pinned group outside its collapsed section with icons=%s", async (icons) => {
    localStorage.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify(["section:Work"]));
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(icons));
    const { row } = await mount([group("team", true)], [bot("regular"), bot("other", "Other")]);
    expect(row("team")?.closest('[data-sidebar-priority-tier="pinned"]')).not.toBeNull();
  });

  it("refuses a pinned group drop into a section", async () => {
    const { host, row, calls } = await mount([group("team", true)], [bot("regular"), bot("other", "Other")]);
    const before = savedOrder();
    const target = host.querySelector('[data-sidebar-item-drop-zone="section:Other"]')!;
    await act(async () => fireDrag(row("team"), "dragstart"));
    await act(async () => fireDrag(target, "dragover"));
    await act(async () => fireDrag(target, "drop"));
    expect(calls).toEqual([]);
    expect(savedOrder()).toEqual(before);
    expect(row("team").closest('[data-sidebar-priority-tier="pinned"]')).not.toBeNull();
  });

  it("Alt+Arrow skips regular rows and swaps same-section pinned rows only", async () => {
    const order = { "section:Work": ["group:team", "bot:regular", "bot:pinned"], "section:Other": ["bot:elsewhere"] };
    localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify({ sectionOrder: ["section:Work", "section:Other"], itemOrder: order }));
    const { row } = await mount([group("team", true)], [bot("regular"), bot("pinned", "Work", true), bot("elsewhere", "Other", true)]);
    const down = async () => act(async () => row("team").querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", altKey: true })));
    await down();
    expect(savedOrder()).toEqual({ ...order, unassigned: [], "section:Work": ["bot:pinned", "bot:regular", "group:team"] });
    await down();
    expect(savedOrder()).toEqual({ ...order, unassigned: [], "section:Work": ["bot:pinned", "bot:regular", "group:team"] });
  });

  it("drags a pinned group among same-section pins without moving regular slots", async () => {
    localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify({ sectionOrder: ["section:Work"], itemOrder: { "section:Work": ["group:team", "bot:regular", "bot:pinned"] } }));
    const { row } = await mount([group("team", true)], [bot("regular"), bot("pinned", "Work", true)]);
    await act(async () => fireDrag(row("team"), "dragstart"));
    await act(async () => fireDrag(row("pinned"), "dragover"));
    await act(async () => fireDrag(row("pinned"), "drop"));
    expect(savedOrder()["section:Work"]).toEqual(["bot:pinned", "bot:regular", "group:team"]);
  });

  it.each([false, true])("opens the group menu after long-press and release with pinned=%s", async (pinned) => {
    const { row } = await mount([group("team", pinned)]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const target = row("team").querySelector("button")!;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
    const touch = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: 100, clientY: 100 }] });
      target.dispatchEvent(event);
    };
    await act(async () => touch("touchstart"));
    await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS));
    await act(async () => touch("touchend"));
    const menu = document.querySelector("[data-room-menu]");
    expect(menu).not.toBeNull();
    expect(menu?.querySelector("button")?.textContent).toBe(pinned ? "Unpin" : "Pin");
  });

  it("search hides a nonmatching pinned group and shows a matching one", async () => {
    const { host } = await mount([group("team", true)]);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search bots and messages"]')!;
    const search = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await search("absent");
    expect(host.querySelector('[data-sidebar-row-id="team"]')).toBeNull();
    await search("team");
    expect(host.querySelector('[data-sidebar-row-id="team"]')).not.toBeNull();
  });
});
