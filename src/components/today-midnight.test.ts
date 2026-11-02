// @vitest-environment happy-dom
import { act, createElement, Fragment, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { StoreProvider, useStore, type ConfigStatus } from "@/state/store";
import { SettingsModal } from "@/components/SettingsModal";
const boundary = Date.parse("2026-11-03T00:00:00+09:00");
const config: ConfigStatus = { composio: { configured: false }, gemini: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" }, rooms: { turnTimeoutMinutes: 5 }, localVm: { mode: "shared", maxInstances: 1 }, profile: { name: "Edward", email: "" }, features: { showToolCalls: false } };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function View({ tick = 0 }) {
  const { state, dispatch } = useStore();
  useEffect(() => { dispatch({ type: "configStatus", config }); dispatch({ type: "toggleAppSettings", open: true, section: "account" }); }, [dispatch]);
  return createElement(Fragment, null, state.appSettingsOpen && createElement(SettingsModal), createElement("output", null, tick));
}
async function draw(tick = 0) { await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(View, { tick }))))); }
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(150); }); }
const todayCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/team/today").length;
const cells = () => [...host.querySelectorAll("section > div > div")].map(cell => cell.textContent);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(boundary - 60000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("omb-locale", "en");
  fetchMock = vi.fn(async (url) => {
    if (url === "/api/instances")
      return Response.json({ instances: [] });
    if (url === "/api/config/status" || url === "/api/config")
      return Response.json(config);
    if (url === "/api/routines")
      return Response.json({ routines: [], runs: [] });
    if (url === "/api/webhooks")
      return Response.json({ webhooks: [], attempts: [], ingress: {} });
    if (url === "/api/google-account")
      return Response.json({ state: "signed-in", email: "owner@example.invalid" });
    if (url === "/api/google-sync")
      return Response.json({ state: "signed-out", email: null, boundEmail: null, join: null, progress: null, lastSyncAt: null });
    if (url === "/api/phone-relay/status")
      return Response.json({ configured: false, available: false });
    if (url === "/api/remote-link")
      return Response.json({ url: null });
    if (url === "/api/key-uses")
      return Response.json({ uses: {} });
    if (url === "/api/team")
      return Response.json({ now: Date.now(), people: [], days: [] });
    if (url === "/api/team/today")
      return Response.json({ snags: Date.now() < boundary ? 2 : 0, bugs: Date.now() < boundary ? 1 : 0, crashes: null, crashCount: null });
    return Response.json({ error: "fixture has no such route" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class {
    onmessage = null;
    close() { }
  });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });
it("Today counts roll over at midnight KST while Settings remains open", async () => {
  await draw();
  await settle();
  const team = [...host.querySelectorAll<HTMLButtonElement>("nav button")].find(button => button.getAttribute("aria-label") === "Team");
  expect(team).toBeDefined();
  await act(async () => team!.click());
  await settle();
  expect(cells()).toContain("2Bot Snags");
  const callsBefore = todayCalls();
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(cells()).toContain("0Bot Snags");
  expect(cells()).toContain("0Bug Reports");
  expect(todayCalls()).toBe(callsBefore + 1);
});
it("unrelated Settings rerenders do not fetch Today on every render", async () => {
  await draw();
  await settle();
  const before = todayCalls();
  expect(before).toBeGreaterThan(0);
  await draw(1);
  await settle();
  await draw(2);
  await settle();
  expect(todayCalls()).toBe(before);
});
it("refreshes after waking on focus and visibility, and cleans up when unmounted", async () => {
  await draw();
  await settle();
  const before = todayCalls();
  vi.setSystemTime(boundary + 86400000);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(todayCalls()).toBe(before + 1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(todayCalls()).toBe(before + 1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(todayCalls()).toBe(before + 2);
  await act(async () => { root.render(null); });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(86400000);
  });
  expect(todayCalls()).toBe(before + 2);
});
