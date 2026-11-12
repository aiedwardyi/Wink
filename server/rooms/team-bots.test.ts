import { rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DATA_DIR } from "../config.ts";
import { Store } from "../store.ts";
import { closeAsksDb, configureRoomAsks, roomAsks, type HostedGroup } from "./asks.ts";
import { closeRoomsDb, createRoom, recentRoomEntries } from "./db.ts";
import { configureRoomDoor, handleRoomDoor, removeRoomPerson, removeRoomTeamBot } from "./door.ts";
import { closeInvitesDb, createInvite } from "./invites.ts";
import { createPeopleOnlyRoom, peopleOnlyRoom } from "./people-only.ts";
import { hostedSend } from "./send.ts";

const HOST = "abcdefghijklmnop.wink.test";

let server: Server;
let port = 0;
let store: Store;
let group: HostedGroup;
let wink: string;

type Reply = { status: number; body: any };

function call(path: string, method: string, key?: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST, "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The first `data:` frames of a stream, then it is cut. */
function frames(path: string, key: string, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: HOST, authorization: `Bearer ${key}` }, agent: false }, (res) => {
      const out: unknown[] = [];
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        let cut: number;
        while ((cut = text.indexOf("\n\n")) >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          if (block.startsWith("data: ")) out.push(JSON.parse(block.slice(6)));
        }
        if (out.length >= count) {
          req.destroy();
          resolve(out);
        }
      });
      res.on("error", () => {});
    });
    req.on("error", (error) => (error.message.includes("socket hang up") ? undefined : reject(error)));
    req.end();
  });
}

async function join(name: string): Promise<{ key: string; id: string }> {
  const { invite, secret } = createInvite(group.hosted.roomId, name, "chat", ["Edward", "Wink"]);
  const res = await call("/room/v1/join", "POST", undefined, { code: `wkr1:${HOST}:${invite.id}.${secret}` });
  expect(res.status).toBe(200);
  return { key: res.body.key, id: res.body.person.id };
}

const room = (path: string) => `/room/v1/rooms/${group.hosted.roomId}/${path}`;

beforeAll(async () => {
  server = createServer((req, res) => void handleRoomDoor(req, res, { host: HOST, peer: null }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  closeInvitesDb();
  closeAsksDb();
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  wink = store.patchBot(store.createBot().id, { name: "Wink", color: "purple" })!.id;
  group = store.createGroup("Team", [wink], false, undefined, undefined, { roomId: createRoom("Team").id }) as HostedGroup;
  configureRoomAsks({ store, hostName: () => "Edward", instance: () => null, dispatch: vi.fn(), stopTurn: vi.fn(async () => {}), endSession: vi.fn(async () => {}) });
  configureRoomDoor({ store, hostName: () => "Edward" });
});

afterEach(() => {
  server.closeAllConnections();
  configureRoomDoor(null);
  configureRoomAsks(null);
  closeInvitesDb();
  closeAsksDb();
  closeRoomsDb();
});

describe("teammates' own bots", () => {
  it("adds a teammate's bot under a host-minted id with its owner, names unique in the room", async () => {
    const peter = await join("Peter");
    const added = await call(room("bots"), "POST", peter.key, { name: "Pete-Coder", color: "teal" });
    expect(added.status).toBe(200);
    expect(added.body.bot).toMatchObject({ owner: peter.id, name: "Pete-Coder", color: "teal" });
    expect(added.body.bot.id).toMatch(/^tb-[\w-]{16}$/);
    expect((await call(room("bots"), "POST", peter.key, { name: "wink", color: "teal" })).status).toBe(409);
    expect((await call(room("bots"), "POST", peter.key, { name: "Peter", color: "teal" })).status).toBe(409);
    const snapshot = await call(room("snapshot?with=bots"), "GET", peter.key);
    expect(snapshot.body.state.teamBots).toEqual([{ id: added.body.bot.id, name: "Pete-Coder", color: "teal", owner: peter.id }]);
    expect(snapshot.body.state.bots).toEqual([{ id: wink, name: "Wink", color: "purple" }]);
    // A later joiner can't take the bot's name.
    const { invite, secret } = createInvite(group.hosted.roomId, "Pete-Coder", "chat", ["Edward", "Wink"]);
    expect((await call("/room/v1/join", "POST", undefined, { code: `wkr1:${HOST}:${invite.id}.${secret}` })).status).toBe(409);
  });

  it("caps each person at five bots", async () => {
    const peter = await join("Peter");
    for (let n = 1; n <= 5; n++) expect((await call(room("bots"), "POST", peter.key, { name: `Bot ${n}` })).status).toBe(200);
    expect((await call(room("bots"), "POST", peter.key, { name: "Bot 6" })).body.error).toBe("too many bots");
  });

  it("leaves a people-only room people-only", async () => {
    group = store.createGroup("Crew", [], false, undefined, undefined, { roomId: createPeopleOnlyRoom("Crew").id }) as HostedGroup;
    const peter = await join("Peter");
    expect((await call(room("bots"), "POST", peter.key, { name: "Pete-Coder" })).status).toBe(200);
    expect(peopleOnlyRoom(group.hosted.roomId)).toBe(true);
    expect(store.group(group.id)?.memberIds).toEqual([]);
  });

  it("posts a bot answer only for its owner, as a bot line with no ask", async () => {
    const peter = await join("Peter");
    const mina = await join("Mina");
    const bot = (await call(room("bots"), "POST", peter.key, { name: "Pete-Coder", color: "teal" })).body.bot;
    const asked = (await call(room("send"), "POST", peter.key, { text: "@Pete-Coder chart this" })).body.entry;
    expect((await call(room("bot-send"), "POST", mina.key, { botId: bot.id, text: "not mine" })).status).toBe(403);
    const posted = await call(room("bot-send"), "POST", peter.key, { botId: bot.id, text: "Here's the chart.", replyToId: asked.id, sendId: "s".repeat(24) });
    expect(posted.status).toBe(200);
    expect(posted.body.entry).toMatchObject({ author: { kind: "bot", id: bot.id, name: "Pete-Coder", owner: peter.id }, text: "Here's the chart.", replyToId: asked.id });
    const again = await call(room("bot-send"), "POST", peter.key, { botId: bot.id, text: "Here's the chart.", replyToId: asked.id, sendId: "s".repeat(24) });
    expect(again.body.entry.id).toBe(posted.body.entry.id);
    expect(recentRoomEntries(group.hosted.roomId, 10)).toHaveLength(2);
    expect(roomAsks(group.hosted.roomId, ["held", "queued", "running"])).toEqual([]);
    expect(store.messagesFor(group.threadId).at(-1)).toMatchObject({ role: "bot", from: { botId: bot.id, name: "Pete-Coder", color: "teal" } });
  });

  it("never wakes the host's only bot for a teammate's bot name or a reply to its line", async () => {
    const peter = await join("Peter");
    const mina = await join("Mina");
    const bot = (await call(room("bots"), "POST", peter.key, { name: "Pete-Coder" })).body.bot;
    expect(hostedSend(group, { kind: "person", id: mina.id }, "@Pete-Coder can you help").ask).toBeNull();
    const asked = hostedSend(group, { kind: "person", id: peter.id }, "@pete-coder chart it").entry;
    expect(roomAsks(group.hosted.roomId, ["held", "queued", "running"])).toEqual([]);
    const answer = (await call(room("bot-send"), "POST", peter.key, { botId: bot.id, text: "done", replyToId: asked.id })).body.entry;
    expect(hostedSend(group, { kind: "person", id: mina.id }, "thanks", answer.id).ask).toBeNull();
    expect(roomAsks(group.hosted.roomId, ["held", "queued", "running"])).toEqual([]);
  });

  it("lets the owner or the host remove a bot, and Remove takes a person's bots with them", async () => {
    const peter = await join("Peter");
    const mina = await join("Mina");
    const one = (await call(room("bots"), "POST", peter.key, { name: "One" })).body.bot;
    const two = (await call(room("bots"), "POST", peter.key, { name: "Two" })).body.bot;
    const minas = (await call(room("bots"), "POST", mina.key, { name: "Mini" })).body.bot;
    expect((await call(room(`bots/${minas.id}/remove`), "POST", peter.key, {})).status).toBe(404);
    expect((await call(room(`bots/${one.id}/remove`), "POST", peter.key, {})).status).toBe(200);
    expect(removeRoomTeamBot(group.hosted.roomId, two.id)).toBe(true);
    expect((await call(room("bot-send"), "POST", peter.key, { botId: two.id, text: "still here?" })).status).toBe(403);
    expect(removeRoomPerson(group.hosted.roomId, mina.id)).toBe(true);
    expect((await call(room("bot-send"), "POST", mina.key, { botId: minas.id, text: "hi" })).status).toBe(401);
    expect((await call(room("snapshot"), "GET", peter.key)).body.state.teamBots).toEqual([]);
  });
});

// The guest schemas exactly as 1.0.256 and the last pre-bots build parse them.
const id = z.string().regex(/^[\w-]{1,64}$/);
const name = z.string().max(200);
const person = z.object({ id, name });
const v256 = (() => {
  const entry = z.object({ seq: z.number().int().positive(), id, at: z.number(), author: z.object({ kind: z.enum(["host", "person", "bot"]), id, name }), text: z.string().max(20_000), replyToId: id.optional() });
  const state = z.object({
    version: z.number().int().nonnegative(), roomName: z.string().max(200), instructions: z.string().max(20_000), host: name, me: person,
    people: z.array(person).max(100), bots: z.array(z.object({ id, name, color: z.string().max(64) })).max(100).default([]),
  });
  return { snapshot: z.object({ head: z.number().int().nonnegative(), entries: z.array(entry).max(1_000), state }), frame: z.discriminatedUnion("kind", [z.object({ kind: z.literal("entry"), entry }), z.object({ kind: z.literal("state"), state })]) };
})();
const preBots = (() => {
  const entry = z.object({ seq: z.number().int().positive(), id, at: z.number(), author: z.object({ kind: z.enum(["host", "person"]), id, name }), text: z.string().max(20_000), replyToId: id.optional() });
  const state = z.object({ version: z.number().int().nonnegative(), roomName: z.string().max(200), instructions: z.string().max(20_000), host: name, me: person, people: z.array(person).max(100) });
  return { snapshot: z.object({ head: z.number().int().nonnegative(), entries: z.array(entry).max(1_000), state }), frame: z.discriminatedUnion("kind", [z.object({ kind: z.literal("entry"), entry }), z.object({ kind: z.literal("state"), state })]) };
})();

describe("old Wink opens a room with a teammate's bot", () => {
  async function seeded() {
    const peter = await join("Peter");
    const old = await join("Sora");
    const bot = (await call(room("bots"), "POST", peter.key, { name: "Pete-Coder", color: "teal" })).body.bot;
    const asked = (await call(room("send"), "POST", peter.key, { text: "@Pete-Coder chart this" })).body.entry;
    await call(room("bot-send"), "POST", peter.key, { botId: bot.id, text: "Here's the chart.", replyToId: asked.id });
    return { old, bot };
  }

  it("loads the snapshot and stream on 1.0.256 as a plain bot line", async () => {
    const { old, bot } = await seeded();
    const snapshot = v256.snapshot.parse((await call(room("snapshot?with=bots"), "GET", old.key)).body);
    expect(snapshot.entries.at(-1)!.author).toEqual({ kind: "bot", id: bot.id, name: "Pete-Coder" });
    expect(snapshot.state).not.toHaveProperty("teamBots");
    const stream = await frames(room("stream?after=0&with=bots"), old.key, 4);
    const parsed = stream.flatMap((frame) => {
      const result = v256.frame.safeParse(frame);
      return result.success ? [result.data] : (frame as { kind: string }).kind === "entry" || (frame as { kind: string }).kind === "state" ? [null] : [];
    });
    expect(parsed).not.toContain(null);
    expect(parsed.some((frame) => frame?.kind === "entry" && frame.entry.author.id === bot.id)).toBe(true);
  });

  it("loads the snapshot and stream before bots in rooms as a person line", async () => {
    const { old, bot } = await seeded();
    const snapshot = preBots.snapshot.parse((await call(room("snapshot"), "GET", old.key)).body);
    expect(snapshot.entries.at(-1)!.author).toEqual({ kind: "person", id: `bot-${bot.id}`, name: "Pete-Coder" });
    expect(`bot-${bot.id}`).toMatch(/^[\w-]{1,64}$/);
    const stream = await frames(room("stream?after=0"), old.key, 4);
    const parsed = stream.flatMap((frame) => ["entry", "state"].includes((frame as { kind: string }).kind) ? [preBots.frame.safeParse(frame).success] : []);
    expect(parsed).toEqual([true, true, true]);
  });
});
