import { afterEach, expect, it, vi } from "vitest";
import { ERROR_SITES } from "../shared/error-report.mjs";

vi.mock("./error-reports.ts", () => ({ reportServerFailure: vi.fn() }));
import { reportServerFailure } from "./error-reports.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("logs quiet rows and reports a distinct site without writing them", async () => {
  const { writeChatError, usageError } = await import("./chat-error.ts");
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(writeChatError("a turn is already running on this thread", null)).toBe(false);
  expect(writeChatError("queued message could not start - no such task", null)).toBe(false);
  expect(usageError("Usage refresh is not supported", null)).toBeUndefined();
  expect(log).toHaveBeenCalledTimes(3);
  expect(reportServerFailure).toHaveBeenCalledWith(null, ERROR_SITES.chatRace);
  expect(reportServerFailure).toHaveBeenCalledWith(null, ERROR_SITES.chatQueue);
  expect(reportServerFailure).toHaveBeenCalledWith(null, ERROR_SITES.usageRefresh);
  expect(writeChatError("unknown failure", null)).toBe(true);
  expect(usageError("Sign in again in Claude", null)).toBe("Sign in again in Claude");
});

it("waits for a queued busy turn instead of dropping its message", async () => {
  const { startQueuedTurn } = await import("./chat-error.ts");
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const run = vi.fn().mockRejectedValueOnce(new Error("the bot is still stopping its last turn - try again in a moment")).mockResolvedValue("started");
  const result = startQueuedTurn(run, () => false, null);
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toBe("started");
  expect(run).toHaveBeenCalledTimes(2);
});

it("stops waiting when a queued send is cancelled", async () => {
  const { startQueuedTurn } = await import("./chat-error.ts");
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let cancelled = false;
  const run = vi.fn().mockRejectedValue(new Error("a turn is already running on this thread"));
  const result = startQueuedTurn(run, () => cancelled, null);
  await vi.advanceTimersByTimeAsync(0);
  cancelled = true;
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toBeUndefined();
  expect(run).toHaveBeenCalledTimes(1);
});
