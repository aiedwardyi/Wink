import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { joinedFileRoute } from "./joined-files.ts";

afterEach(() => rmSync(join(DATA_DIR, "picture-test"), { recursive: true, force: true }));

it("serves the joined state's picture through a read-only route", async () => {
  const path = join(DATA_DIR, "picture-test", "photo");
  mkdirSync(join(DATA_DIR, "picture-test"), { recursive: true });
  writeFileSync(path, "photo");
  const picture = vi.fn(async () => ({ ok: true, value: { path, file: { id: "P".repeat(24), name: "picture", type: "image/png", bytes: 5, sha256: "a".repeat(64) } } }));
  const client = { start: vi.fn(), picture, file: vi.fn(), upload: vi.fn() };
  const server = createServer(async (req, res) => {
    if (!(await joinedFileRoute(req, res, req.method!, new URL(req.url!, "http://localhost"), client as never))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/api/joined/rooms/r1/picture`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("photo");
    expect(picture).toHaveBeenCalledWith("r1");
    expect((await fetch(`${base}/api/joined/rooms/r1/picture`, { method: "POST" })).status).toBe(404);
    expect(client.upload).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
