// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { noticeStalls, stallNotice, stallTime, useSyncStalls } from "./sync-stall";

const NOW = new Date(2026, 9, 26, 22, 0).getTime();
const TODAY = new Date(2026, 9, 26, 18, 25).getTime();
const YESTERDAY = new Date(2026, 9, 25, 16, 38).getTime();
// The desktop toast waits on the icon fetch.
const flush = () => new Promise((done) => setTimeout(done, 0));
const pc = (deviceId: string, current = false) => ({ deviceId, name: deviceId, current });

function installDesktop() {
  const shown = vi.fn();
  vi.stubGlobal("ogb", { showNotification: shown });
  return shown;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sync stall", () => {
  it("tells the time it stopped, with the date when not today", () => {
    expect(stallTime(TODAY, "en", NOW)).toMatch(/^6:25\sPM$/);
    expect(stallTime(YESTERDAY, "en", NOW)).toMatch(/^Oct 25, 4:38\sPM$/);
  });

  it("tells the time in Korean on a ko-KR PC", () => {
    // ICU 78 writes PM where older ICU wrote 오후.
    expect(stallTime(TODAY, "ko", NOW)).toMatch(/^(오후|PM) 6:25$/);
    expect(stallTime(YESTERDAY, "ko", NOW)).toMatch(/^10월 25일 (오후|PM) 4:38$/);
    expect(stallNotice(pc("Work"), { since: TODAY, reason: "held" }, "ko", NOW)).toMatchObject({
      title: `Work에서 ${stallTime(TODAY, "ko", NOW)}부터 동기화가 멈췄어요`,
      body: "그 PC의 다른 앱에서 파일을 열고 있어요. Wink가 계속 다시 시도해요.",
    });
    expect(stallNotice(pc("Home", true), { since: TODAY, reason: "held" }, "ko", NOW).body).toBe("다른 앱에서 파일을 열고 있어요. Wink가 계속 다시 시도해요.");
    expect(stallNotice(pc("Work"), { since: TODAY, reason: "error" }, "ko", NOW).body).toBe("그 PC에서 Wink를 열어 이유를 확인하세요.");
    expect(stallNotice(pc("Home", true), { since: TODAY, reason: "error" }, "ko", NOW).body).toBe("설정 → 동기화에서 이유를 확인하세요.");
  });

  it.each([
    [false, "held", "A file there is open in another app. Wink keeps retrying."],
    [true, "held", "A file is open in another app. Wink keeps retrying."],
    [false, "error", "Open Wink on that PC to see why."],
    [true, "error", "See why in Settings → Sync."],
  ] as const)("says why for this PC %s, %s", (current, reason, body) => {
    const notice = stallNotice(pc("Work", current), { since: YESTERDAY, reason }, "en", NOW);
    expect(notice.title).toMatch(/^Work stopped syncing at Oct 25, 4:38\sPM$/);
    expect(notice.body).toBe(body);
  });

  it("notifies once per stall, and again for a new one", async () => {
    const shown = installDesktop();
    const devices = [{ ...pc("once-work"), stuck: { since: TODAY, reason: "held" as const } }, { ...pc("once-home", true), stuck: { since: TODAY, reason: "error" as const } }, pc("once-laptop")];
    noticeStalls(devices, "en");
    noticeStalls(devices, "en");
    await flush();
    expect(shown.mock.calls.map(([payload]) => payload.threadId)).toEqual(["sync-stall:once-work", "sync-stall:once-home"]);
    noticeStalls([{ ...pc("once-work"), stuck: { since: NOW, reason: "held" } }], "en");
    await flush();
    expect(shown).toHaveBeenCalledTimes(3);
  });

  it("hands the desktop toast no chat it could hide behind", async () => {
    const shown = installDesktop();
    noticeStalls([{ ...pc("focus-work"), stuck: { since: TODAY, reason: "held" } }], "en");
    await flush();
    expect(shown).toHaveBeenCalledWith({
      title: expect.stringMatching(/^focus-work stopped syncing at .*6:25\sPM$/),
      body: "A file there is open in another app. Wink keeps retrying.",
      botId: "sync",
      threadId: "sync-stall:focus-work",
      visibleThreadId: null,
    });
  });

  it("polls the PC list only in the desktop app", async () => {
    const fetch = vi.fn(async () => Response.json({ devices: [{ ...pc("poll-work"), stuck: { since: TODAY, reason: "error" } }] }));
    vi.stubGlobal("fetch", fetch);
    const Probe = () => {
      useSyncStalls();
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => root.unmount());

    const shown = installDesktop();
    const desktop = createRoot(document.createElement("div"));
    await act(async () => desktop.render(createElement(Probe)));
    await flush();
    expect(fetch).toHaveBeenCalledWith("/api/devices", expect.anything());
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^poll-work stopped syncing at /), body: "Open Wink on that PC to see why." }));
    await act(async () => desktop.unmount());
  });
});
