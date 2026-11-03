import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempDirs } from "./cleanup.ts";

const files = [
  "server/memory-pass.test.ts", "server/memory-pass.guard.test.ts", "server/remote-access.test.ts",
  "server/team-report-fixes.test.ts", "server/team-reports.test.ts", "server/device-sync.test.ts",
  "server/thread-sync-v2-gate.test.ts", "server/early-listen.test.ts", "server/compression.test.ts",
  "server/drivers/acp/acp.test.ts", "server/drivers/msp/runtime.test.ts", "server/drivers/acp/muse.test.ts",
  "server/automatic-selection-route.test.ts", "relay/test/scripts.test.ts",
];

describe("test temp ownership", () => {
  it("bounds six locked directories to one retry window", async () => {
    const owned = createTempDirs();
    const dirs = Array.from({ length: 6 }, () => owned.make(join(tmpdir(), "cleanup-locked-")));
    const original = fs.rmSync;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const remove = vi.spyOn(fs, "rmSync").mockImplementation((dir, options) => {
      if (dirs.includes(String(dir))) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      original(dir, options);
    });
    syncBuiltinESMExports();
    try {
      let done = false;
      const pending = owned.remove().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(2_000);
      const bounded = done;
      await vi.runAllTimersAsync();
      await pending;
      expect(bounded).toBe(true);
      expect(warn).toHaveBeenCalledTimes(6);
    } finally {
      remove.mockRestore();
      syncBuiltinESMExports();
      vi.useRealTimers();
      warn.mockRestore();
      for (const dir of dirs) original(dir, { recursive: true, force: true });
    }
  });

  it("removes only the directories registered by its suite", async () => {
    const parent = createTempDirs();
    const owned = createTempDirs();
    const root = parent.make(join(tmpdir(), "cleanup-test-"));
    const target = owned.make(join(root, "owned-"));
    writeFileSync(join(root, "user-file"), "keep");
    await owned.remove();
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(root, "user-file"), "utf8")).toBe("keep");
    await owned.remove();
    await parent.remove();
  });

  it.each(files)("registers leaked temp folders in %s", (file) => {
    const text = readFileSync(resolve(process.env.DISK_AUTO_SOURCE_ROOT || ".", file), "utf8");
    expect(text).toContain("createTempDirs");
    expect(text).toContain("afterAll(() => temps.remove())");
    expect(text).toContain("temps.make(join(tmpdir(),");
  });
});
