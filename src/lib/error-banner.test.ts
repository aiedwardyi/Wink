import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

it("gives a newer error its full six seconds", async () => {
  const { createErrorBanner } = await import("./error-banner");
  vi.useFakeTimers();
  const publish = vi.fn();
  const banner = createErrorBanner(publish);
  banner.show(new Error("first"));
  vi.advanceTimersByTime(5000);
  banner.show(new Error("second"));
  vi.advanceTimersByTime(1000);
  expect(publish).toHaveBeenLastCalledWith("second");
  vi.advanceTimersByTime(5000);
  expect(publish).toHaveBeenLastCalledWith(null);
});

it("does not publish an internal send race", async () => {
  const { createErrorBanner } = await import("./error-banner");
  const publish = vi.fn();
  const banner = createErrorBanner(publish);
  banner.show(new Error("sendId already belongs to another message"));
  expect(publish).not.toHaveBeenCalled();
  banner.dispose();
});
