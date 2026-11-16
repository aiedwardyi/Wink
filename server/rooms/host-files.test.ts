import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { createGroupRoutes } from "../group-routes.ts";
import { SendSequencer } from "../send-idempotency.ts";
import { Store, type Message } from "../store.ts";
import { closeAsksDb, configureRoomAsks, type HostedGroup } from "./asks.ts";
import { addPerson, closeRoomsDb, createRoom, recentRoomEntries } from "./db.ts";
import { listRoomFiles } from "./files.ts";
import { hostRoomFiles, hostSend } from "./send.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from("%PDF-1.4\n% host doc\n");

let store: Store;
let group: HostedGroup;
let local: string;

function routes(botCaller = false) {
  return createGroupRoutes({
    store,
    sendSequencer: new SendSequencer(),
    resolveReplyTarget: () => undefined,
    groupIsWorking: () => false,
    botCaller: () => botCaller,
    startGroupTurn: (groupId: string, text: string, replyTo?: Message, sendId?: string, _asker?: string, _card?: string, roomFileIds?: readonly string[]) =>
      hostSend(store.group(groupId) as HostedGroup, text, replyTo, sendId, roomFileIds).message,
  } as unknown as Parameters<typeof createGroupRoutes>[0]);
}

async function send(text: string, sendId = "send-0123456789abcdef", botCaller = false) {
  const req = Readable.from([JSON.stringify({ text, sendId })]) as unknown as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await routes(botCaller).postMessage(req, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
  return { status: res.writeHead.mock.calls[0][0] as number, body: JSON.parse(res.end.mock.calls[0][0]) };
}

const put = (name: string, bytes: Buffer) => {
  const path = join(local, name);
  writeFileSync(path, bytes);
  return path;
};
const image = (path: string) => `<attached-image path="${path}" />`;
const file = (path: string, name: string, extra = "") => `<attached-file path="${path}" name="${name}" size="9"${extra} />`;
const lastEntry = () => recentRoomEntries(group.hosted.roomId, 1).at(-1)!;

beforeEach(() => {
  closeRoomsDb();
  closeAsksDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  local = mkdtempSync(join(tmpdir(), "host-files-"));
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  const wink = store.patchBot(store.createBot().id, { name: "Wink" })!.id;
  group = store.createGroup("Team", [wink], false, undefined, undefined, { roomId: createRoom("Team").id }) as HostedGroup;
  addPerson(group.hosted.roomId, "Peter", ["Wink"]);
  configureRoomAsks({ store, hostName: () => "Edward", instance: () => null, dispatch: vi.fn(), stopTurn: vi.fn(async () => {}), endSession: vi.fn(async () => {}) });
});
afterEach(() => {
  configureRoomAsks(null);
  closeAsksDb();
  closeRoomsDb();
  rmSync(local, { recursive: true, force: true });
});

describe("the host's files in a room with people and bots", () => {
  it("reach teammates as room files, while the bots keep the full text", async () => {
    const text = `look\n\n${image(put("shot.png", PNG))}\n\n${file(put("plan.pdf", PDF), "plan.pdf")}`;
    expect((await send(text)).status).toBe(202);
    const entry = lastEntry();
    expect(entry.text).toBe("look");
    expect(entry.files?.map((each) => [each.name, each.type])).toEqual([["shot.png", "image/png"], ["plan.pdf", "application/pdf"]]);
    const row = store.messagesFor(group.threadId).find((message) => message.roomEntryId === entry.id)!;
    expect(row.text).toBe(text);
    // the host's own bubble draws its local files; the room's copies would show twice
    expect(row.roomFiles).toBeUndefined();
    expect(listRoomFiles(group.hosted.roomId, "Edward").files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "shot.png", sender: "Edward" }),
      expect.objectContaining({ name: "plan.pdf", sender: "Edward" }),
    ]));
  });

  it("sends several pictures with no words and one file for a big picture's smaller copy", async () => {
    const big = put("big.png", PNG);
    const small = put("big-small.png", PNG);
    const text = [image(put("a.png", PNG)), image(put("b.png", PNG)), image(small), file(big, "big.png", ` preview="${small}"`)].join("\n\n");
    expect((await send(text)).status).toBe(202);
    expect(lastEntry()).toMatchObject({ text: "" });
    expect(lastEntry().files?.map((each) => each.name)).toEqual(["a.png", "b.png", "big.png"]);
  });

  it("refuses the whole send over a file a teammate's upload would be refused, naming it", async () => {
    const before = store.messagesFor(group.threadId).length;
    const refused = await send(`here\n\n${file(put("tool.exe", Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e])), "tool.exe")}`);
    expect(refused).toEqual({ status: 415, body: { error: "only pictures, video, audio, PDF, zip, Office and text files can be shared", code: "ROOM_FILE", file: "tool.exe" } });
    expect(store.messagesFor(group.threadId)).toHaveLength(before);
    expect((await send(Array.from({ length: 51 }, () => image(join(local, "x.png"))).join("\n"), "send-many-0123456789")).body).toMatchObject({ code: "ROOM_FILE", error: "at most 50 files per message" });
  });

  it("reuses a retried send's files", async () => {
    const text = image(put("shot.png", PNG));
    const first = await hostRoomFiles(group, text, "send-retry-0123456789");
    expect(await hostRoomFiles(group, text, "send-retry-0123456789")).toEqual(first);
    expect(listRoomFiles(group.hosted.roomId, "Edward").files).toHaveLength(1);
  });

  it("leaves a bot's own call as names", async () => {
    expect((await send(`see ${image(put("shot.png", PNG))}`, undefined, true)).status).toBe(202);
    expect(lastEntry()).toMatchObject({ text: "see [image]" });
    expect(lastEntry().files).toBeUndefined();
    expect(listRoomFiles(group.hosted.roomId, "Edward").files).toEqual([]);
  });
});
