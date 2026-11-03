import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { augmentedPath, findCliCandidates, refreshPathCache, resetPathCacheForTests } from "./env-path.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const platform = process.platform;
const name = "rc-only-cli";
let shellResult: (error: Error | null, stdout: string) => void;
let oldBin: string;
let newBin: string;

describe("login-shell candidate invalidation", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("PATH", "");
    oldBin = join(homedir(), "old-bin");
    newBin = join(homedir(), "rc-bin");
    mkdirSync(oldBin, { recursive: true });
    mkdirSync(newBin, { recursive: true });
    writeFileSync(join(newBin, name), "fixture");
    vi.stubEnv("OMB_EXTRA_PATH", oldBin);
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      shellResult = args.at(-1) as typeof shellResult;
      return {} as ReturnType<typeof execFile>;
    });
    resetPathCacheForTests();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetPathCacheForTests();
  });

  it("invalidates cached misses when the login-shell PATH arrives", async () => {
    await refreshPathCache([name]);
    expect(findCliCandidates(name)).toEqual([]);
    shellResult(null, `__OMB_PATH__${newBin}`);
    expect(findCliCandidates(name)).toEqual([join(newBin, name)]);
  });

  it("discards an in-flight scan when the login-shell PATH changes", async () => {
    augmentedPath();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readdir).mockImplementationOnce(async (...args: Parameters<typeof readdir>) => {
      await held;
      return original.readdir(...args);
    });
    const scan = refreshPathCache([name]);
    await vi.waitFor(() => expect(readdir).toHaveBeenCalled());
    shellResult(null, `__OMB_PATH__${newBin}`);
    release();
    await scan;
    expect(findCliCandidates(name)).toEqual([join(newBin, name)]);
  });
});
