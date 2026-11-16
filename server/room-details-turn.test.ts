import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGroupRoutes } from "./group-routes.ts";
import { roomResponders, Store, type GroupRecord } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const selection = () => ({ instanceId: "fake", model: "m" });

let dir: string | undefined;
afterEach(async () => { if (dir) await removeTempDir(dir); dir = undefined; });

describe("a new room", () => {
  it("opens at once: setup is marked skipped, so an old build skips it too", () => {
    const store = new Store(selection);
    const group = store.createGroup("Wink team", [store.createBot().id]);
    expect(group.setupSkippedAt).toEqual(expect.any(Number));
    expect(group.setupCompletedAt).toBeNull();
    expect(new Store(selection).group(group.id)?.setupSkippedAt).toBe(group.setupSkippedAt);
  });

  it("keeps a completed setup completed", () => {
    const store = new Store(selection);
    const group = store.createGroup("Launch", [store.createBot().id], false, undefined, { bulletin: "", completed: true });
    expect(group).toMatchObject({ setupCompletedAt: expect.any(Number), setupSkippedAt: null });
  });

  it("takes the folder and who answers set in Room details on its next turn", async () => {
    dir = mkdtempSync(join(tmpdir(), "room-details-"));
    const store = new Store(selection);
    const kai = store.createBot();
    const ray = store.createBot();
    store.patchBot(kai.id, { name: "Kai" });
    store.patchBot(ray.id, { name: "Ray" });
    const group = store.createGroup("Wink team", [kai.id, ray.id]);
    const routes = createGroupRoutes({
      store, groupIsWorking: () => false, publicGroupState: (value: GroupRecord) => value, checkedGroupResponder: (value: unknown) => value,
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const patch = async (body: object) => {
      const res = { writeHead: vi.fn(), end: vi.fn() };
      await routes.patch(Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
      return res.writeHead.mock.calls[0][0];
    };

    expect(await patch({ cwd: dir })).toBe(200);
    expect(await patch({ defaultResponder: { kind: "member", botId: ray.id } })).toBe(200);

    expect(store.pinGroupCwd(group.id, group.threadId)).toBe(dir);
    expect(roomResponders("thoughts?", [kai, ray], store.group(group.id)!.defaultResponder).map((bot) => bot.id)).toEqual([ray.id]);
  });
});
