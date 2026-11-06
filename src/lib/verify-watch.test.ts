import { expect, it } from "vitest";
import type { VerifyCardData, VerifyIssue } from "../../shared/live-verify";
import { renderBeat, BEAT_MS } from "./verify-beat";
import { verifyCardAction, verifyEndTab, verifyLiveGate, verifyReel } from "./verify-watch";

const now = 100_000;
const card = (patch: Partial<VerifyCardData> = {}): VerifyCardData => ({ v: 1, runId: "run", owner: "bot", site: "index.html", status: "completed", mode: "auto", decisionNonce: "n", offeredAt: now - 5000, startedAt: now - 5000, endedAt: now, ...patch });
const issue = (where: string, tile: VerifyIssue["tile"] = "desktop"): VerifyIssue => ({ checker: "LINKS", tile, rule: "missing target", where, measured: "x" });

it("offers Watch live while a run streams on desktop, Watch once replays are kept, else Rerun", () => {
  expect(verifyCardAction(card({ status: "running", live: true }), false, now)).toBe("live");
  expect(verifyCardAction(card({ status: "running" }), false, now)).toBeNull();
  expect(verifyCardAction(card({ status: "waiting" }), false, now)).toBeNull();
  expect(verifyCardAction(card({ replay: ["a", "b"] }), false, now)).toBe("watch");
  expect(verifyCardAction(card(), false, now)).toBe("rerun");
  expect(verifyCardAction(card({ status: "blocked", replay: ["a"] }), false, now)).toBe("watch");
});

it("never offers live on a phone, only Watch after the end", () => {
  expect(verifyCardAction(card({ status: "running", live: true, replay: ["a"] }), true, now)).toBeNull();
  expect(verifyCardAction(card({ status: "preparing", live: true }), true, now)).toBeNull();
  expect(verifyCardAction(card({ replay: ["a"] }), true, now)).toBe("watch");
});

it("opens the live view only while the panel is open, the chat is shown and the window is visible", () => {
  expect(verifyLiveGate(true, false, "visible")).toBe(true);
  expect(verifyLiveGate(false, false, "visible")).toBe(false);
  expect(verifyLiveGate(true, true, "visible")).toBe(false);
  expect(verifyLiveGate(true, false, "hidden")).toBe(false);
});

it("reels up to 5 problems in the card's order and ends on the tab with problems", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map(where => issue(where, where === "a" ? "phone" : "desktop"));
  expect(verifyReel(rows).map(row => row.where)).toEqual(["a", "b", "c", "d", "e"]);
  expect(verifyEndTab([])).toBe("desktop");
  expect(verifyEndTab([issue("a", "phone")])).toBe("phone");
  expect(verifyEndTab([issue("a", "phone"), issue("b")])).toBe("desktop");
});

it("puts a kick on every 174 BPM beat in the captured track", () => {
  const rate = 8000, track = renderBeat(rate, 2000);
  const peaks = [0, 1, 2, 3, 4].map(beat => {
    const at = Math.round(beat * BEAT_MS * rate / 1000);
    return Math.max(...track.subarray(at, at + 40).map(Math.abs));
  });
  for (const peak of peaks) expect(peak).toBeGreaterThan(0.3);
  const quiet = Math.round((BEAT_MS * 0.75) * rate / 1000);
  expect(Math.max(...track.subarray(quiet, quiet + 40).map(Math.abs))).toBeLessThan(0.25);
});
