import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import type { RoutineManager } from "./routines.ts";
import { createTeamRoutes } from "./team-routes.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});
vi.mock("./bot-directory.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-directory.ts")>()),
  fetchBotDirectory: async () => [],
}));

const dir = mkdtempSync(join(tmpdir(), "omb-scout-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const networkPaths = ["\\\\host\\share", "//host/share", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "\\/host/share", '"\\\\host\\share"', " //host/share "];

describe.each(["scout", "directory"] as const)("/api/teams/%s from a phone", (name) => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let desktop: boolean;

  beforeEach(async () => {
    vi.mocked(statSync).mockClear();
    const routes = createTeamRoutes({ cfg: {} as AppConfig, routines: {} as RoutineManager } as never);
    server = createServer((req, res) => { void routes[name](res, new URL(req.url!, "http://x"), desktop); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => { server.close(); });

  const get = (cwd: string) => fetch(`${base}/?cwd=${encodeURIComponent(cwd)}`);

  it.each(networkPaths)("refuses %j before any filesystem call", async (cwd) => {
    desktop = false;
    const response = await get(cwd);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(statSync).not.toHaveBeenCalled();
  });

  it("still reaches the folder check for the desktop", async () => {
    desktop = true;
    vi.mocked(statSync).mockImplementationOnce(() => { throw new Error("ENOENT"); });
    const response = await get("//host/share");
    expect(response.status).toBe(400);
    expect(statSync).toHaveBeenCalled();
  });

  it("serves a local folder", async () => {
    desktop = false;
    expect((await get(dir)).status).toBe(200);
  });
});
