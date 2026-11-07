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

it("tags a sign-in error with the added account that failed, through the bus", async () => {
  const { runtimeErrorTool } = await import("./chat-error.ts");
  const { EventBus } = await import("./harness/bus.ts");
  const { makeFakeDriver } = await import("./testing/fake-driver.ts");
  const fake = makeFakeDriver();
  for (const instanceId of ["fake", "acct_00000000-0000-4000-8000-000000000002"]) {
    await fake.driver.create({ instanceId, displayName: undefined, environment: {}, enabled: true, config: {} });
  }
  const bus = new EventBus(() => {});
  bus.attach([...fake.created.values()].map(({ instance }) => instance));
  const seen: ReturnType<typeof runtimeErrorTool>[] = [];
  bus.subscribe((event) => { if (event.type === "runtime.error") seen.push(runtimeErrorTool(event, (id) => id.startsWith("acct_"))); });
  const fail = (instanceId: string, signIn?: boolean) => fake.created.get(instanceId)!.emit({
    eventId: "e", provider: "fake", threadId: "t", createdAt: new Date().toISOString(), type: "runtime.error", message: "Claude is not signed in.", signIn,
  });
  fail("acct_00000000-0000-4000-8000-000000000002", true);
  fail("acct_00000000-0000-4000-8000-000000000002");
  fail("fake", true);
  expect(seen.map((tool) => JSON.parse(JSON.stringify(tool)))).toEqual([
    { name: "error: Claude is not signed in.", ok: false, signIn: true, accountId: "acct_00000000-0000-4000-8000-000000000002" },
    { name: "error: Claude is not signed in.", ok: false },
    { name: "error: Claude is not signed in.", ok: false, signIn: true },
  ]);
});
