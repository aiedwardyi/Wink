// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { FIRST_SYNC_POLL_MS } from "@/lib/use-first-sync";
import { SyncingBotsLine } from "./SyncingBotsLine";

let status: object = {};
let asks = 0;
let failing = false;
let root: Root | null = null;
const onOpen = vi.fn();

const google = (extra: object) => ({ state: "up-to-date", email: "edward@example.com", boundEmail: null, join: null, progress: null, lastSyncAt: 1, ...extra });

async function render(recheck: string) {
  if (!root) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(SyncingBotsLine, { recheck, onOpen }))));
  await act(async () => {});
}

const line = () => document.querySelector<HTMLButtonElement>("[data-first-sync]");

beforeEach(() => {
  asks = 0;
  failing = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path !== "/api/google-sync") return Response.json({ error: "no route" }, { status: 404 });
    asks += 1;
    return failing ? Response.json({ error: "down" }, { status: 500 }) : Response.json(status);
  }));
  localStorage.setItem("omb-locale", "en");
});

afterEach(async () => {
  status = google({});
  await render("reset");
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
  onOpen.mockClear();
});

describe("SyncingBotsLine", () => {
  it("shows nothing on a PC that is not on its first sync", async () => {
    status = google({});
    await render("a");
    expect(line()).toBeNull();
    status = google({ state: "syncing", progress: { done: 3, total: 9 } });
    await render("b");
    expect(line()).toBeNull();
  });

  it("shows the first sync, then finishing up, then goes away", async () => {
    status = google({ state: "joining", progress: { done: 3905, total: 7634 }, firstSync: true });
    await render("a");
    expect(line()?.textContent).toBe("Syncing your bots from your other PCs · 3,905 of 7,634 · You can keep using Wink");
    await act(async () => line()!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    status = google({ state: "syncing", progress: { done: 7634, total: 7634 }, firstSync: true });
    await render("b");
    expect(line()?.textContent).toBe("Syncing your bots from your other PCs · Finishing up… · You can keep using Wink");
    status = google({ firstSync: true, finishing: true });
    await render("c");
    expect(line()?.textContent).toContain("Finishing up…");
    status = google({});
    await render("d");
    expect(line()).toBeNull();
  });

  it("asks again only while the first sync runs", async () => {
    vi.useFakeTimers();
    status = google({ state: "joining", progress: { done: 1, total: 9 }, firstSync: true });
    await render("a");
    expect(asks).toBe(1);
    status = google({});
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_SYNC_POLL_MS); });
    expect(asks).toBe(2);
    expect(line()).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_SYNC_POLL_MS * 3); });
    expect(asks).toBe(2);
  });

  it("keeps asking after one failed status request", async () => {
    vi.useFakeTimers();
    status = google({ state: "joining", progress: { done: 1, total: 9 }, firstSync: true });
    await render("a");
    failing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_SYNC_POLL_MS); });
    expect(asks).toBe(2);
    failing = false;
    status = google({});
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_SYNC_POLL_MS); });
    expect(asks).toBe(3);
    expect(line()).toBeNull();
  });

  it("speaks Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    status = google({ state: "joining", progress: { done: 3905, total: 7634 }, firstSync: true });
    await render("a");
    expect(line()?.textContent).toBe("다른 PC에서 봇을 동기화하는 중 · 3,905/7,634 · Wink를 계속 사용할 수 있어요");
  });
});
