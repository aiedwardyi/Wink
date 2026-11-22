import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TERMINAL_READ_QUIET_MS, TERMINAL_READ_SLOW_MS, traceTerminalRead } from "./terminal-read-log.ts";

afterEach(() => vi.useRealTimers());

function read(botId: string, options: { relay?: boolean; statusCode?: number; finished?: boolean; bytes?: number; took?: number } = {}) {
  const lines: string[] = [];
  const socket = { bytesWritten: 1000 };
  const res = Object.assign(new EventEmitter(), { statusCode: options.statusCode ?? 200, writableFinished: options.finished ?? true, socket });
  // SAFETY: the log reads only once(), statusCode, writableFinished and socket.bytesWritten, all present on this stand-in.
  traceTerminalRead(botId, options.relay ?? false, performance.now(), res as never, (line) => lines.push(line));
  vi.advanceTimersByTime(options.took ?? 20);
  socket.bytesWritten += options.bytes ?? 512;
  res.emit("close");
  return lines;
}

describe("terminal read log", () => {
  it("writes one line with the bot, route, arrival, answer time, bytes and status", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(Date.UTC(2026, 10, 22, 4, 54, 5));
    const [line] = read("bot-1", { relay: true, bytes: 4321, took: 87 });
    expect(line).toBe("terminal read: bot=bot-1 via=relay arrived=2026-11-22T04:54:05.000Z ms=87 bytes=4321 status=200");
  });

  it("names a local read and an aborted one", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    expect(read("bot-1")[0]).toMatch(/ via=local /);
    vi.advanceTimersByTime(TERMINAL_READ_QUIET_MS);
    expect(read("bot-1", { finished: false })[0]).toMatch(/ status=aborted$/);
  });

  it("logs a polled bot's quick good reads once per quiet window, and every slow or failed one", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    expect(read("bot-2")).toHaveLength(1);
    expect(read("bot-2")).toHaveLength(0);
    expect(read("bot-3")).toHaveLength(1);
    expect(read("bot-2", { took: TERMINAL_READ_SLOW_MS })).toHaveLength(1);
    expect(read("bot-2", { statusCode: 503 })).toHaveLength(1);
    expect(read("bot-2", { finished: false })).toHaveLength(1);
    expect(read("bot-2")).toHaveLength(0);
    vi.advanceTimersByTime(TERMINAL_READ_QUIET_MS);
    expect(read("bot-2")).toHaveLength(1);
  });
});
