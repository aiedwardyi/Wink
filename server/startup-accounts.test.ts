import { describe, expect, it, vi } from "vitest";

const enable = vi.hoisted(() => vi.fn(async (_access: unknown) => {}));
vi.mock("./worker-panes.ts", () => ({ enableWorkerAccounts: enable }));

import { restoreStartupAccounts } from "./startup-accounts.ts";

describe("startup accounts", () => {
  it("keeps validation behind worker account routing", async () => {
    let release!: () => void;
    enable.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const restore = vi.fn(async () => {});
    const pending = restoreStartupAccounts(null, restore);
    expect(restore).not.toHaveBeenCalled();
    release();
    await pending;
    expect(restore).toHaveBeenCalledOnce();
  });

  it("retains validation when the native bridge is unavailable", async () => {
    enable.mockRejectedValueOnce(new Error("unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = vi.fn(async () => {});
    try {
      await restoreStartupAccounts(null, restore);
      expect(restore).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
});
