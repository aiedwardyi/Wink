// @vitest-environment happy-dom
// Connections never reads usage: the Gemini row looks the same in every login mode whether or not a usage
// report is held, so showing or clearing Gemini's bars cannot move it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistPreference, I18nProvider } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const { state, request, refreshInstances } = vi.hoisted(() => ({
  state: { bots: [{ modelSelection: { instanceId: "gemini" } }], instances: [] as InstanceInfo[] },
  request: vi.fn(),
  refreshInstances: vi.fn(async () => {}),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: request,
  useStore: () => ({ state, dispatch: vi.fn(), refreshInstances }),
}));
import { EnginesSettings } from "./EnginesSettings";

let root: Root;
let host: HTMLDivElement;
const report = { observedAt: new Date(0).toISOString(), ageMs: 0, windows: [{ id: "five_hour", usedPercent: 30, resetsAt: null }, { id: "seven_day", usedPercent: 9, resetsAt: null }] };
const MODES = {
  plan: { state: "available", authChecked: true, authenticated: true, account: "person@example.test" },
  "API key": { state: "available", authChecked: true, authenticated: true },
  "ADC / Cloud": { state: "available", authChecked: true, authenticated: true, account: "service@project.example.test" },
  "signed out": { state: "available", authChecked: true, authenticated: false },
} satisfies Record<string, InstanceInfo["snapshot"]>;

const connections = async (snapshot: InstanceInfo["snapshot"], rateLimits: InstanceInfo["rateLimits"]) => {
  state.instances = [{
    instanceId: "gemini", driverKind: "antigravityAgent", displayName: "Gemini", snapshot, rateLimits,
    models: { default: "gemini-4-neon", options: [] },
  } as InstanceInfo];
  await act(async () => root.render(createElement(I18nProvider, null, createElement(EnginesSettings))));
  return host.innerHTML;
};

beforeEach(() => {
  persistPreference("en");
  vi.stubGlobal("ogb", undefined);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  request.mockReset().mockImplementation(async (path: string) => path === "/api/accounts" ? { accounts: [] } : {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(Object.entries(MODES))("the Gemini Connections row is the same with or without a usage report: %s", async (_mode, snapshot) => {
  const held = await connections(snapshot, report);
  const none = await connections(snapshot, undefined);
  expect(held).toContain("Gemini");
  expect(held).toBe(none);
});

it("the four login modes still read differently from one another", async () => {
  const rows = new Set<string>();
  for (const snapshot of Object.values(MODES)) rows.add(await connections(snapshot, undefined));
  expect(rows.size).toBeGreaterThan(1);
});
