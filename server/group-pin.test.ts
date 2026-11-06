import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createGroupRoutes } from "./group-routes.ts";
import { Store, type GroupRecord } from "./store.ts";

function setup() {
  const store = new Store(() => ({ instanceId: "fake", model: "m" }));
  const bot = store.createBot();
  const group = store.createGroup("Team", [bot.id]);
  const routes = createGroupRoutes({ store, groupIsWorking: () => false, publicGroupState: (value: GroupRecord) => value } as unknown as Parameters<typeof createGroupRoutes>[0]);
  const patch = async (body: unknown) => {
    const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.patch(req, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    return { status: res.writeHead.mock.calls[0][0], body: JSON.parse(res.end.mock.calls[0][0]) };
  };
  const reload = () => new Store(() => ({ instanceId: "fake", model: "m" })).group(group.id);
  return { group, patch, reload };
}

describe("group pin", () => {
  it("persists a pin through a new Store", async () => {
    const { patch, reload } = setup();
    const { status, body } = await patch({ pinned: true });
    expect(status).toBe(200);
    expect(body.group).toMatchObject({ pinned: true });
    expect(reload()).toMatchObject({ pinned: true });
  });

  it("persists and returns explicit false when unpinned", async () => {
    const { patch, reload } = setup();
    await patch({ pinned: true });
    const { status, body } = await patch({ pinned: false });
    expect(status).toBe(200);
    expect(body.group).toMatchObject({ pinned: false });
    expect(reload()).toMatchObject({ pinned: false });
  });

  it("rejects a nonboolean pin without changing the record", async () => {
    const { group, patch, reload } = setup();
    await patch({ pinned: true });
    const before = structuredClone(group);
    const { status, body } = await patch({ pinned: "yes" });
    expect(status).toBe(400);
    expect(body).toEqual({ error: "pinned must be a boolean" });
    expect(group).toEqual(before);
    expect(reload()).toEqual(before);
  });
});
