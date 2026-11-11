import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import type { RoutineManager } from "./routines.ts";
import { Store, type BotRecord, type GroupRecord } from "./store.ts";
import { createTeamRoutes } from "./team-routes.ts";
import { openSse } from "./testing/sse.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
type ImportResult = { bots: BotRecord[]; groups: GroupRecord[]; group: GroupRecord };
const document = {
  format: "openmaus.package",
  version: 1,
  package: {
    id: "research-desk",
    release: "1.0.0",
    name: "Research Desk",
    tagline: "Research together.",
    summary: "A research team.",
    category: "Research",
    author: { name: "Tester" },
    license: "MIT",
    outcomes: ["Produce a brief."],
    setupMinutes: 3,
    requirements: { apps: [], capabilities: [] },
    agents: [{ key: "lead", name: "Ada", title: "Lead", description: "Own the brief.", appearance: { color: "purple" } }],
    rooms: ["Research", "Review"].map((name, index) => ({
      key: `room-${index}`,
      name,
      members: ["lead"],
      bulletin: "Cite sources.",
      defaultResponder: { kind: "agent", agent: "lead" },
    })),
  },
};

describe("package room imports", () => {
  const clients = new Set<ServerResponse>();
  let store: Store;
  let server: ReturnType<typeof createServer>;
  let base: string;

  beforeEach(async () => {
    store = new Store(selection);
    const broadcast = (payload: Record<string, unknown>) => {
      for (const client of clients) client.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    store.onChange((change) => {
      if (change.type === "group") {
        const group = store.group(change.groupId);
        if (group) broadcast({ kind: "group", group: { ...group, messages: [], working: false } });
      }
      if (change.type === "bot") broadcast({ kind: "bot", bot: store.bot(change.botId) });
    });
    const routes = createTeamRoutes({
      cfg: {} as AppConfig,
      store,
      routines: {} as RoutineManager,
      defaultSelection: async () => selection(),
      publicBot: (bot) => ({ ...bot }),
      publicGroupState: (group) => ({ ...group, messages: [], working: false }),
      broadcast,
    });
    server = createServer((req, res) => {
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": connected\n\n");
        clients.add(res);
        res.on("close", () => clients.delete(res));
        return;
      }
      void routes.importTeam(req, res, new URL(req.url!, base)).then(() => {
        broadcast({ kind: "import.done" });
      }).catch((error) => {
        res.writeHead(500);
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const client of clients) client.end();
    clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("broadcasts every package room once to a second subscribed client", async () => {
    const first = await openSse(`${base}/events`);
    const second = await openSse(`${base}/events`);
    try {
      const response = await fetch(`${base}/import`, { method: "POST", body: JSON.stringify(document) });
      expect(response.status).toBe(201);
      const imported = await response.json() as ImportResult;
      await second.until((frame) => frame.kind === "import.done");
      await first.until((frame) => frame.kind === "import.done");
      for (const recorder of [first, second]) {
        const groups = recorder.frames.filter((frame) => frame.kind === "group").map((frame) => frame.group);
        expect(groups.map((group) => group.id).sort()).toEqual(imported.groups.map((group: { id: string }) => group.id).sort());
        expect(groups).toEqual(expect.arrayContaining(imported.groups.map((group: { id: string }) =>
          expect.objectContaining({ id: group.id, bulletin: "Cite sources.", messages: [], working: false }))));
      }
    } finally {
      first.close();
      second.close();
    }
  });

  it("erases the bots of a rolled back import outright", async () => {
    const before = store.bots.map((bot) => bot.id);
    vi.spyOn(store, "createGroup").mockImplementation(() => {
      throw new Error("disk full");
    });

    const response = await fetch(`${base}/import`, { method: "POST", body: JSON.stringify(document) });

    expect(response.status).toBe(500);
    expect(store.bots.map((bot) => bot.id)).toEqual(before);
    expect(store.trash.entries).toEqual([]);
  });

  it("honors the caller's project folder and room name for package imports", async () => {
    const query = new URLSearchParams({ mode: "project", cwd: homedir(), room: "Current project" });
    const response = await fetch(`${base}/import?${query}`, { method: "POST", body: JSON.stringify(document) });
    expect(response.status).toBe(201);
    const imported = await response.json() as ImportResult;
    expect(imported.group).toMatchObject({ name: "Current project", cwd: homedir(), memberIds: [imported.bots[0].id] });
    expect(store.group(imported.group.id)?.cwd).toBe(homedir());
    expect(imported.groups).toHaveLength(3);
  });
});
