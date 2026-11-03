import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDirs } from "./cleanup.ts";

const files = [
  "server/memory-pass.test.ts", "server/memory-pass.guard.test.ts", "server/remote-access.test.ts",
  "server/team-report-fixes.test.ts", "server/team-reports.test.ts", "server/device-sync.test.ts",
  "server/thread-sync-v2-gate.test.ts", "server/early-listen.test.ts", "server/compression.test.ts",
  "server/drivers/acp/acp.test.ts", "server/drivers/msp/runtime.test.ts", "server/drivers/acp/muse.test.ts",
  "server/automatic-selection-route.test.ts", "relay/test/scripts.test.ts",
];

describe("test temp ownership", () => {
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
