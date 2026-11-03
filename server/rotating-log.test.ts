import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appendRotatingLog, LOG_MAX_BYTES, removeRotatingLog } from "./rotating-log.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

describe("log caps", () => {
  it("caps native and events logs at 256 MB", () => {
    expect(LOG_MAX_BYTES).toBe(256 * 1024 * 1024);
  });

  it("rotates only the old file and appends to a fresh live file", () => {
    const file = join(temps.make(join(tmpdir(), "log-cap-")), "thread.ndjson");
    writeFileSync(file, "old-tail");
    writeFileSync(`${file}.1`, "older-tail");
    appendRotatingLog(file, "live\n", 8);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("old-tail");
    expect(readFileSync(file, "utf8")).toBe("live\n");
    appendRotatingLog(file, "next\n", 8);
    expect(readFileSync(file, "utf8")).toBe("live\nnext\n");
    expect(readFileSync(`${file}.1`, "utf8")).toBe("old-tail");
  });

  it("creates the live file before a backup is needed", () => {
    const file = join(temps.make(join(tmpdir(), "log-cap-")), "thread.ndjson");
    appendRotatingLog(file, "first\n", 8);
    expect(readFileSync(file, "utf8")).toBe("first\n");
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it("removes an orphaned backup without touching another thread", () => {
    const dir = temps.make(join(tmpdir(), "log-cap-"));
    const file = join(dir, "deleted.ndjson");
    writeFileSync(`${file}.1`, "backup");
    writeFileSync(join(dir, "kept.ndjson.1"), "keep");
    removeRotatingLog(file);
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(readFileSync(join(dir, "kept.ndjson.1"), "utf8")).toBe("keep");
  });
});
