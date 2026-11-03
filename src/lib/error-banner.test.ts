import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "./i18n";

afterEach(() => { vi.useRealTimers(); applyLocale("en"); });

it.each(["bot", "channel"])("publishes translated send and Stop failures for a %s task switch", async (target) => {
  const { createErrorBanner } = await import("./error-banner");
  const publish = vi.fn();
  const banner = createErrorBanner(publish);
  try {
    banner.show(new Error(`the ${target} switched tasks before it could receive the message`));
    expect(publish).toHaveBeenLastCalledWith("Not sent. The chat moved to another task. Send your message again.");
    banner.show(new Error(`the ${target} switched tasks before it could be interrupted`));
    expect(publish).toHaveBeenLastCalledWith("Couldn't stop. The chat moved to another task. Try again.");
    applyLocale("ko");
    banner.show(new Error(`the ${target} switched tasks before it could receive the message`));
    expect(publish).toHaveBeenLastCalledWith("전송되지 않았어요. 채팅이 다른 작업으로 바뀌었어요. 메시지를 다시 보내 주세요.");
    banner.show(new Error(`the ${target} switched tasks before it could be interrupted`));
    expect(publish).toHaveBeenLastCalledWith("멈추지 못했어요. 채팅이 다른 작업으로 바뀌었어요. 다시 시도해 주세요.");
  } finally {
    banner.dispose();
  }
});

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
