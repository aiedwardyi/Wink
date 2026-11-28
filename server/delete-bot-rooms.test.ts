import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTestData, testHome } from "./testing/test-home.ts";
import { removeRotatingLog } from "./rotating-log.ts";
import { createWarmPool } from "./drivers/warm-pool.ts";

// deleteBotFully and removeSyncedBots are private to index.ts, which these
// tests must not boot; their wiring is pinned on source, same idiom as chief-of-staff.test.ts.
const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8").replace(/\r\n/g, "\n");
const fn = (name: string) => {
  const start = index.indexOf(`async function ${name}(`);
  return index.slice(start, index.indexOf("\n}\n", start));
};

let home: string;

async function freshStore() {
  home = mkdtempSync(join(testHome(), "omb-delete-bot-rooms-"));
  vi.resetModules();
  vi.stubEnv("OMB_DATA_DIR", join(home, ".orbit"));
  const { Store, roomResponders } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), roomResponders };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  if (home) removeTestData(home);
});

describe("deleting a bot that leads a room", () => {
  it("drops it from the roster, hands the lead on, and clears its busy claim", async () => {
    const { store, roomResponders } = await freshStore();
    const lead = store.createBot();
    const other = store.createBot();
    const room = store.createGroup("Product", [lead.id, other.id], false, undefined, { defaultResponder: { kind: "member", botId: lead.id } });
    store.patchGroup(room.id, { busyBotId: lead.id });
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));

    expect(store.deleteBot(lead.id)).toBe(true);

    const after = store.group(room.id)!;
    expect(after.memberIds).toEqual([other.id]);
    expect(after.defaultResponder).toEqual({ kind: "member", botId: other.id });
    expect(after.busyBotId).toBeNull();
    const members = after.memberIds.map((id) => store.bot(id)!);
    expect(roomResponders("ship it", members, after.defaultResponder).map((bot) => bot.id)).toEqual([other.id]);
    expect(changes).toContainEqual({ type: "group", groupId: room.id });
  });

  it("keeps a mentions-only room on mentions", async () => {
    const { store } = await freshStore();
    const lead = store.createBot();
    const other = store.createBot();
    const room = store.createGroup("Product", [lead.id, other.id]);
    store.patchGroup(room.id, { defaultResponder: { kind: "mentions" } });

    store.deleteBot(lead.id);

    expect(store.group(room.id)).toMatchObject({ memberIds: [other.id], defaultResponder: { kind: "mentions" } });
  });

  it("leaves a DM pair and a sole-member room as a member edit would", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const peer = store.createBot();
    const solo = store.createGroup("Solo", [bot.id]);
    const dm = store.createGroup("DM", [bot.id, peer.id], true);
    store.patchGroup(dm.id, { busyBotId: bot.id });

    store.deleteBot(bot.id);

    expect(store.group(solo.id)?.memberIds).toEqual([bot.id]);
    expect(store.group(dm.id)).toMatchObject({ memberIds: [bot.id, peer.id], busyBotId: null });
  });
});

describe("deleteBotFully", () => {
  const noop = () => {};
  const deleteWith = (overrides: Record<string, unknown>) => {
    const deps = {
      botAccounts: { instance: () => undefined },
      registry: { get: () => undefined }, store: { groups: [], deleteBot: noop },
      stopScreenPoller: noop, activeVpsThreads: new Map(), routines: { disableForBot: noop }, webhooks: { disableForBot: noop },
      lastReply: new Map(), cancelPeerApprovalsFor: noop, discardDelegations: noop, commsBus: {}, discardDelegationsFrom: noop,
      computerControl: { forget: noop }, paneWake: { forgetBot: noop }, taskResumes: { forgetBot: noop }, accountNotices: { forget: noop }, limitWaits: { cancel: noop },
      perBotLocalVmTarget: () => ({ key: "vm" }), localVmIdles: new Map(), warmPool: { retire: noop },
      EVENTS_DIR: "", NATIVE_DIR: "", join, removeRotatingLog: noop,
      ...overrides,
    };
    const javascript = ts.transpileModule(`${fn("stopBotWork")}\n}\n${fn("deleteBotFully")}\n}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    return new Function(...Object.keys(deps), `${javascript}\nreturn deleteBotFully;`)(...Object.values(deps));
  };

  it("is the path a delete synced from another PC takes", async () => {
    expect(fn("removeSyncedBots")).toContain("await deleteBotFully(bot);");
    expect(fn("deleteBotFully")).toContain("store.deleteBot(bot.id);");
    // what that path does to rooms here
    const { store } = await freshStore();
    const lead = store.createBot();
    const other = store.createBot();
    const room = store.createGroup("Product", [lead.id, other.id]);
    store.deleteBot(lead.id);
    expect(store.group(room.id)?.memberIds).toEqual([other.id]);
  });

  it("interrupts a room turn the bot is running before the store forgets the room claim", () => {
    const stop = fn("stopBotWork");
    const lookup = stop.indexOf("store.groups.filter((g) => g.busyBotId === bot.id)");
    expect(lookup).toBeGreaterThan(-1);
    expect(stop.indexOf("interruptTurn(group.threadId)")).toBeGreaterThan(lookup);
    const body = fn("deleteBotFully");
    const stopped = body.indexOf("await stopBotWork(bot);");
    expect(stopped).toBeGreaterThan(-1);
    expect(body.indexOf("store.deleteBot(bot.id);")).toBeGreaterThan(stopped);
  });

  it("retires a warm child its bot started on an engine it has since left", async () => {
    const warmPool = createWarmPool({ totalmem: () => 32 * 1024 ** 3, freemem: () => 16 * 1024 ** 3, cpus: () => 16 });
    const lease = warmPool.reserve({ engine: "antigravityAgent", instanceId: "gemini", threadId: "t1" }, "fp", { generation: 0, incarnation: "i", identity: "" }, "speculative");
    if (typeof lease === "string") throw new Error(lease);
    const close = vi.fn(async () => {});
    lease.attach({ session: { kind: "fresh" }, alive: () => true, close });
    lease.ready();
    const deleteBotFully = deleteWith({ warmPool });

    await deleteBotFully({ id: "bot-1", threadId: "t1", modelSelection: { instanceId: "codex" }, tasks: [] });

    expect(close).toHaveBeenCalledOnce();
    // the standby its last turn starts at exit is refused
    expect(warmPool.generation(lease.key)).toBe(1);
  });

  it("removes the event logs of every task, not just the open one", async () => {
    home = mkdtempSync(join(testHome(), "omb-delete-bot-logs-"));
    const dirs = ["events", "native"].map((name) => join(home, name));
    for (const dir of dirs) {
      mkdirSync(dir);
      for (const threadId of ["t1", "t2"]) writeFileSync(join(dir, `${threadId}.ndjson`), "{}");
    }
    const deleteBotFully = deleteWith({ EVENTS_DIR: dirs[0], NATIVE_DIR: dirs[1], removeRotatingLog });

    await deleteBotFully({ id: "bot-1", threadId: "t1", modelSelection: { instanceId: "claude" }, tasks: [{ threadId: "t1" }, { threadId: "t2" }] });

    for (const dir of dirs) expect(["t1", "t2"].map((threadId) => existsSync(join(dir, `${threadId}.ndjson`)))).toEqual([false, false]);
  });
});

describe("a Gemini standby whose chat or room has ended", () => {
  const gemini = { instanceId: "gemini", model: "gemini-4-neon" };
  const codex = { instanceId: "codex", model: "gpt-5" };
  // the owner index.ts registers, with each bot's own pick for its account
  const ownerOf = (store: unknown) => {
    const source = index.match(/warmPool\.setOwner\("antigravityAgent", (.+)\);\n/)?.[1];
    if (!source) throw new Error("index.ts registers no Gemini owner");
    return new Function("store", "botAccounts", `return ${source};`)(store, { instance: (bot: { modelSelection: { instanceId: string } }) => ({ instanceId: bot.modelSelection.instanceId }) });
  };
  const key = (threadId: string) => ({ engine: "antigravityAgent", instanceId: "gemini", threadId });
  const captured = { generation: 0, incarnation: "i", identity: "" };

  it.each([
    ["bot delete", async (store: any, bot: any) => { store.deleteBot(bot.id); }],
    ["room delete", async (store: any, _bot: any, room: any) => { store.deleteGroup(room.id); }],
    ["engine pick", async (store: any, bot: any) => { store.patchBot(bot.id, { modelSelection: codex }); }],
    ["room member's engine pick", async (store: any, bot: any) => { store.patchBot(bot.id, { modelSelection: codex }); }],
    ["archive", async (store: any, bot: any) => { store.patchBot(bot.id, { hidden: true }); }],
    ["room member's archive", async (store: any, bot: any) => { store.patchBot(bot.id, { hidden: true }); }],
    ["mid-reply pick", async (store: any, bot: any) => {
      store.patchBot(bot.id, { pendingModelSelection: codex });
      store.patchBot(bot.id, { modelSelection: codex, pendingModelSelection: undefined });
    }],
    ["quit", async (_store: any, _bot: any, _room: any, pool: any) => { await pool.closeAll("exit", { final: true }); }],
  ])("leaves no slot held after %s", async (path, exit) => {
    const { store } = await freshStore();
    const pool = createWarmPool({ totalmem: () => 32 * 1024 ** 3, freemem: () => 16 * 1024 ** 3, cpus: () => 16 });
    pool.setOwner("antigravityAgent", ownerOf(store));
    const children: Array<ReturnType<typeof vi.fn>> = [];
    const stale = [store.createBot({ modelSelection: gemini }), store.createBot({ modelSelection: gemini })].map((bot) => {
      const room = store.createGroup(bot.name, [bot.id]);
      const threadId = path.startsWith("room") ? room.threadId : bot.threadId;
      const lease = pool.reserve(key(threadId), "fp", captured, "speculative");
      if (typeof lease === "string") throw new Error(lease);
      const close = vi.fn(async () => {});
      lease.attach({ session: { kind: "fresh" }, alive: () => true, close });
      lease.ready();
      children.push(close);
      return { bot, room, lease, threadId };
    });
    // a pick held for a running turn lands at settle, then the exiting child asks for a standby
    if (path === "mid-reply pick") for (const { lease, threadId } of stale) expect(pool.take(key(threadId), "fp", captured, null)).toEqual({ hit: lease });
    for (const { bot, room } of stale) await exit(store, bot, room, pool);
    if (path === "mid-reply pick") {
      for (const { lease, threadId } of stale) {
        lease.release("used");
        expect(pool.reserve(key(threadId), "fp", captured, "speculative")).toBe("denied");
      }
    }

    const next = store.createBot({ modelSelection: gemini });
    const lease = pool.reserve(key(next.threadId), "fp", captured, "speculative");
    if (path === "quit") expect(lease).toBe("denied");
    else expect(typeof lease).toBe("object");
    for (const close of children) expect(close).toHaveBeenCalledOnce();
    await expect.poll(() => pool.stats().byEngine.antigravityAgent ?? 0).toBe(path === "quit" ? 0 : 1);
  });
});
