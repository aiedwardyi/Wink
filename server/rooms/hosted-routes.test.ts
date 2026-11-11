import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { createGroupRoutes } from "../group-routes.ts";
import { Store, type BotRecord, type GroupRecord } from "../store.ts";
import { addPerson, closeRoomsDb, roomById } from "./db.ts";

let store: Store;
const engines = new Map<string, string>();

function routes() {
  return createGroupRoutes({
    store,
    instanceForBot: (bot: BotRecord) => ({ driverKind: engines.get(bot.id) }),
    checkedMemberIds: (value: unknown) => ({ ok: true, memberIds: value as string[] }),
    checkedGroupResponder: () => ({ kind: "everyone" }),
    publicGroupState: (group: GroupRecord) => group,
    groupWithThread: (group: GroupRecord) => group,
    groupIsWorking: () => false,
    broadcast: () => {},
    createGroupTaskRequestSchema: { safeParse: () => ({ success: true, data: { title: "Next" } }) },
  } as unknown as Parameters<typeof createGroupRoutes>[0]);
}

async function call(handler: (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => Promise<unknown>, body: unknown, m: string[] = []) {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await handler(req, res as unknown as ServerResponse, ["", ...m] as RegExpMatchArray);
  return { status: res.writeHead.mock.calls[0][0] as number, body: JSON.parse(res.end.mock.calls[0][0]) };
}

const bot = (name: string, driverKind: string) => {
  const record = store.patchBot(store.createBot().id, { name })!;
  engines.set(record.id, driverKind);
  return record.id;
};

beforeEach(() => {
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
});
afterEach(closeRoomsDb);

describe("hosted group routes", () => {
  it("creates a team room", async () => {
    const wink = bot("Wink", "claudeAgent");
    const created = await call(routes().create, { name: "Team", memberIds: [wink], hosted: true });
    expect(created.status).toBe(201);
    const group = store.group(created.body.group.id)!;
    expect(roomById(group.hosted!.roomId)).toMatchObject({ name: "Team" });
    expect((await call(routes().create, { name: "Plain", memberIds: [wink] })).status).toBe(201);
    expect(store.groups.find((g) => g.name === "Plain")!.hosted).toBeUndefined();
  });

  it.each(["grok", "antigravityAgent", "boxAgent", "museAgent"])("shares a %s bot at create", async (driverKind) => {
    const result = await call(routes().create, { name: "Team", memberIds: [bot("Wink", "codex"), bot("Odd", driverKind)], hosted: true });
    expect(result.status).toBe(201);
  });

  it("refuses a bot add whose name clashes with a person", async () => {
    const wink = bot("Wink", "claudeAgent");
    const { body } = await call(routes().create, { name: "Team", memberIds: [wink], hosted: true });
    const group = store.group(body.group.id)!;
    addPerson(group.hosted!.roomId, "Mina", "chat", ["Wink"]);
    expect((await call(routes().patch, { memberIds: [wink, bot("mina", "codex")] }, [group.id])).body.error).toMatch(/already called mina/);
    expect((await call(routes().patch, { memberIds: [wink, bot("Helper", "codex")] }, [group.id])).status).toBe(200);
  });

  it("keeps a team room to one conversation", async () => {
    const { body } = await call(routes().create, { name: "Team", memberIds: [bot("Wink", "codex")], hosted: true });
    const group = store.group(body.group.id)!;
    const r = routes();
    const refused = { status: 409, body: { error: "a team room keeps one conversation" } };
    expect(await call(r.createTask, { title: "Next" }, [group.id])).toEqual(refused);
    expect(await call(r.patchTask, { title: "Renamed" }, [group.id, group.threadId])).toEqual(refused);
    expect(await call((_req, res, m) => r.deleteTask(res, m), {}, [group.id, group.threadId])).toEqual(refused);
    expect(store.groupTasks(group.id)).toHaveLength(1);
  });

  it("opens an older task of a shared group to read, keeping the shared thread active", async () => {
    const group = store.createGroup("Crew", [bot("Wink", "codex")]);
    const old = group.threadId;
    store.appendMessage(old, { role: "user", kind: "text", text: "private plan" });
    store.createGroupTask(group.id);
    const shared = store.patchGroup(group.id, { hosted: { roomId: "room-1" } })!;
    const open = (threadId: string) => call((_req, res, m) => routes().switchTask(res, m, new URL("http://x/")), {}, [group.id, threadId]);
    expect(await open(old)).toEqual({ status: 200, body: { group: expect.objectContaining({ id: group.id, threadId: old }) } });
    expect((await open("nope")).status).toBe(404);
    expect(store.group(group.id)!.threadId).toBe(shared.threadId);
    expect(store.messagesFor(old).map((message) => message.text)).toEqual(["private plan"]);
  });
});
