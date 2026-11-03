import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureDirs, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { appendNative } from "./drivers/native.ts";
import { EventBus } from "./harness/bus.ts";

vi.mock("./rotating-log.ts", async (original) => {
  const actual = await original<typeof import("./rotating-log.ts")>();
  return { ...actual, appendRotatingLog: (file: string, text: string) => actual.appendRotatingLog(file, text, 8) };
});

beforeAll(ensureDirs);

describe("thread log caps", () => {
  it("rotates native history before writing the live message", () => {
    const file = join(NATIVE_DIR, "cap-native.ndjson");
    writeFileSync(file, "old-tail");
    appendNative("cap-native", { dir: "out", source: "test", msg: "new message" });
    expect(readFileSync(`${file}.1`, "utf8")).toBe("old-tail");
    expect(readFileSync(file, "utf8")).toContain("new message");
  });

  it("rotates event history before writing the live event", () => {
    const file = join(EVENTS_DIR, "cap-events.ndjson");
    writeFileSync(file, "old-tail");
    const bus = new EventBus();
    bus.publish({ eventId: "test", threadId: "cap-events", type: "turn.started", provider: "fake", createdAt: new Date().toISOString() } as RuntimeEvent);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("old-tail");
    expect(readFileSync(file, "utf8")).toContain("turn.started");
  });
});
