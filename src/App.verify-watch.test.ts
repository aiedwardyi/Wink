// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "./App";
import { closeVerifyWatch } from "@/lib/verify-watch";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

vi.mock("../shared/live-verify", async importOriginal => ({ ...await importOriginal<typeof import("../shared/live-verify")>(), LIVE_VERIFY_V0: true }));

let host: HTMLDivElement;
let root: Root;
const cards = ["first", "second"].map(owner => ({ v: 1, runId: owner, owner, site: `${owner}/index.html`, status: "completed", mode: "auto", decisionNonce: `${owner}-nonce`, offeredAt: Date.now(), replay: [owner] }));

beforeEach(() => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: cards.map(card => ({ id: card.owner, threadId: `${card.owner}-thread`, name: card.owner, messages: [], modelSelection: { instanceId: "inst", model: "m" } })),
    groups: [{ id: "g1", threadId: "gt1", name: "Crew", memberIds: ["first", "second"], defaultResponder: "all", bulletin: "", unread: false, createdAt: 1, messages: cards.map(card => ({ id: card.owner, role: "bot", kind: "note", text: "", at: 1, verify: card })) }],
    selectedId: "g1",
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => init?.method === "POST" && url.includes("/decision") ? Promise.resolve(new Response("{}")) : new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  closeVerifyWatch();
  host.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("watches the clicked owner's card in a group and reruns that same card", async () => {
  await act(async () => root.render(createElement(App)));
  for (let i = 0; i < 100 && !host.querySelector("[data-verify-watch]"); i++) await act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
  const buttons = host.querySelectorAll<HTMLButtonElement>("button[data-verify-watch]");
  expect(buttons).toHaveLength(2);
  await act(async () => buttons[0]!.click());
  for (let i = 0; i < 100 && !host.querySelector(".verify-watch-url"); i++) await act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
  expect(host.querySelector(".verify-watch-url")?.textContent).toBe("first/index.html");
  await act(async () => host.querySelector<HTMLButtonElement>('.verify-watch button[aria-label="Rerun"]')!.click());
  expect(fetch).toHaveBeenCalledWith("/api/verify/runs/first/decision", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "rerun", nonce: "first-nonce", owner: "first", threadId: "gt1" }) }));
});

it("watches the older of two episode cards from the same owner", async () => {
  const episodes = ["older", "newer"].map(id => ({ id, role: "bot", kind: "note", text: "", at: 1, verify: { ...cards[0], runId: id, site: `${id}/index.html`, replay: [id] } }));
  const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_CACHE_KEY)!);
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ ...snapshot, groups: [{ ...snapshot.groups[0], messages: episodes }] }));
  await act(async () => root.render(createElement(App)));
  for (let i = 0; i < 100 && !host.querySelector("[data-verify-watch]"); i++) await act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
  await act(async () => host.querySelectorAll<HTMLButtonElement>("button[data-verify-watch]")[0]!.click());
  for (let i = 0; i < 100 && !host.querySelector(".verify-watch-url"); i++) await act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
  expect(host.querySelector(".verify-watch-url")?.textContent).toBe("older/index.html");
});
