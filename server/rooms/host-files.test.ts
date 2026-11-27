import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestData, testHome } from "../testing/test-home.ts";

import { ATTACHMENTS_DIR } from "../attachments.ts";
import { DATA_DIR } from "../config.ts";
import { createGroupRoutes } from "../group-routes.ts";
import { createInternalRoutes } from "../internal-routes.ts";
import { markRelaySocket } from "../phone-relay/via.ts";
import { SendSequencer } from "../send-idempotency.ts";
import { Store, type BotRecord, type Message } from "../store.ts";
import { createThreadRoutes } from "../thread-routes.ts";
import { turnUnread } from "../turn-reply.ts";
import { askById, closeAsksDb, configureRoomAsks, startAsk, type HostedGroup } from "./asks.ts";
import { addPerson, closeRoomsDb, createRoom, recentRoomEntries, roomPeople } from "./db.ts";
import { hostFileRoute } from "./file-routes.ts";
import { listRoomFiles } from "./files.ts";
import { publishTurnAnswer } from "./multiplayer.ts";
import { captureHostBotPicture, hostedSend, hostRoomFiles, hostSend } from "./send.ts";

const copying = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }));
vi.mock("./send.ts", async (actual) => {
  const real = await actual<typeof import("./send.ts")>();
  return { ...real, hostRoomFiles: vi.fn(async (...args: Parameters<typeof real.hostRoomFiles>) => {
    await copying.before?.();
    return real.hostRoomFiles(...args);
  }) };
});

// a share path must never reach the disk: Windows would dial out over SMB
vi.mock("node:fs/promises", async (actual) => {
  const real = await actual<typeof import("node:fs/promises")>();
  return { ...real, open: vi.fn((path: string, ...rest: []) => (/^[\\/]{2}/.test(String(path)) ? Promise.reject(new Error("share opened")) : real.open(path, ...rest))) };
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from("%PDF-1.4\n% host doc\n");

let store: Store;
let group: HostedGroup;
let local: string;

function routes(botCaller = false) {
  return createGroupRoutes({
    broadcast: vi.fn(),
    cancelGroupTurnOperations: vi.fn(),
    closeOpenApprovals: vi.fn(),
    publicGroupState: vi.fn(() => ({})),
    taskResumes: { forgetThread: vi.fn() },
    store,
    sendSequencer: new SendSequencer(),
    resolveReplyTarget: () => undefined,
    groupIsWorking: () => false,
    botCaller: () => botCaller,
    startGroupTurn: (groupId: string, text: string, replyTo?: Message, sendId?: string, _asker?: string, _card?: string, roomFileIds?: readonly string[]) =>
      hostSend(store.group(groupId) as HostedGroup, text, replyTo, sendId, roomFileIds).message,
  } as unknown as Parameters<typeof createGroupRoutes>[0]);
}

async function send(text: string, sendId = "send-0123456789abcdef", botCaller = false, made = routes(botCaller), phone = false) {
  const req = Readable.from([JSON.stringify({ text, sendId })]) as unknown as IncomingMessage;
  if (phone) {
    const socket = new PassThrough();
    markRelaySocket(socket);
    Object.assign(req, { socket });
  }
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await made.postMessage(req, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
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
  removeTestData(DATA_DIR);
  local = mkdtempSync(join(tmpdir(), "host-files-"));
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  const wink = store.patchBot(store.createBot().id, { name: "Wink", cwd: local })!.id;
  group = store.createGroup("Team", [wink], false, undefined, undefined, { roomId: createRoom("Team").id }) as HostedGroup;
  addPerson(group.hosted.roomId, "Peter", ["Wink"]);
  configureRoomAsks({ store, hostName: () => "Edward", instance: () => null, dispatch: vi.fn(), stopTurn: vi.fn(async () => {}), endSession: vi.fn(async () => {}) });
});
afterEach(() => {
  copying.before = null;
  vi.mocked(open).mockClear();
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
    expect((await send(Array.from({ length: 51 }, () => image(put("x.png", PNG))).join("\n"), "send-many-0123456789")).body).toMatchObject({ code: "ROOM_FILE", error: "at most 50 files per message" });
  });

  it("reuses a retried send's files", async () => {
    const text = image(put("shot.png", PNG));
    const first = await hostRoomFiles(group, text, "send-retry-0123456789");
    expect(await hostRoomFiles(group, text, "send-retry-0123456789")).toEqual(first);
    expect(listRoomFiles(group.hosted.roomId, "Edward").files).toHaveLength(1);
  });

  it("refuses a retry whose file changed since its first copy", async () => {
    const path = put("shot.png", PNG);
    await hostRoomFiles(group, image(path), "send-changed-0123456789");
    writeFileSync(path, Buffer.concat([PNG, PNG]));
    await expect(hostRoomFiles(group, image(path), "send-changed-0123456789")).rejects.toMatchObject({ status: 409, code: "ROOM_FILE" });
  });

  it("keeps a Stop pressed while the files copy", async () => {
    const made = routes();
    const before = store.messagesFor(group.threadId).length;
    copying.before = async () => {
      const req = Readable.from([]) as unknown as IncomingMessage;
      await made.interrupt(req, { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    };
    expect(await send(image(put("shot.png", PNG)), undefined, false, made)).toMatchObject({ body: { cancelled: true } });
    expect(store.messagesFor(group.threadId)).toHaveLength(before);
  });

  it("leaves a bot's own call as names", async () => {
    expect((await send(`see ${image(put("shot.png", PNG))}`, undefined, true)).status).toBe(202);
    expect(lastEntry()).toMatchObject({ text: "see [image]" });
    expect(lastEntry().files).toBeUndefined();
    expect(listRoomFiles(group.hosted.roomId, "Edward").files).toEqual([]);
  });
});

describe("a host bot's picture in a room with people", () => {
  async function showCat(caption = " A cat ") {
    const bot = store.bot(group.memberIds[0]!)!;
    const routes = createInternalRoutes({
      readOnlyTurn: () => false, ownerTurn: () => false,
      cfg: {},
      store,
      connectorThread: () => ({ group }),
      botOutputRoots: () => [local],
      captureRoomPicture: (from: BotRecord, threadId: string) => captureHostBotPicture(store, from, threadId, () => false),
    } as unknown as Parameters<typeof createInternalRoutes>[0]);
    const res = { writeHead: vi.fn(), end: vi.fn() };
    const body = { fromBotId: bot.id, fromThreadId: group.threadId, path: put("cat.png", PNG), caption };
    await routes.showImage(Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { bot, status: res.writeHead.mock.calls[0]![0] as number, body: JSON.parse(res.end.mock.calls[0]![0]) };
  }

  it("reaches teammates as a room file on the bot's own line, and stays inline on the host", async () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const attachments = readdirSync(ATTACHMENTS_DIR);
    const { bot, status, body } = await showCat();
    expect(status).toBe(201);
    const entry = lastEntry();
    expect(entry).toMatchObject({ author: { kind: "bot", id: bot.id, name: "Wink" }, text: "A cat" });
    expect(entry.files?.map((each) => [each.name, each.type])).toEqual([["cat.png", "image/png"]]);
    const rows = store.messagesFor(group.threadId).filter((message) => message.role === "bot");
    expect(rows).toEqual([expect.objectContaining({ kind: "screen", roomFiles: entry.files, text: "A cat", roomEntryId: entry.id, from: expect.objectContaining({ botId: bot.id }) })]);
    expect(rows[0]?.image).toBeUndefined();
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual(attachments);
    expect(body).toEqual({ messageId: rows[0]!.id, url: `/api/rooms/${group.hosted.roomId}/files/${entry.files![0]!.id}/preview` });
    const threadRoutes = createThreadRoutes({ store, dataDir: DATA_DIR } as Parameters<typeof createThreadRoutes>[0]);
    const response = new PassThrough();
    const bytes: Buffer[] = [];
    response.on("data", (chunk: Buffer) => bytes.push(chunk));
    const received = once(response, "end");
    const writeHead = vi.fn();
    await threadRoutes.messageImage({ headers: {} } as Parameters<typeof threadRoutes.messageImage>[0], Object.assign(response, { writeHead }) as unknown as ServerResponse,
      ["", group.threadId, body.messageId] as RegExpMatchArray);
    expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "content-type": "image/png" }));
    await received;
    expect(Buffer.concat(bytes)).toEqual(PNG);
  });

  it("answers a teammate's ask with a picture alone", async () => {
    const peter = roomPeople(group.hosted.roomId)[0]!;
    const { ask } = hostedSend(group, { kind: "person", id: peter.id }, "@Wink draw a cat");
    expect(startAsk(ask!.id)).toBeTruthy();
    const since = store.messagesFor(group.threadId).length;
    const { bot } = await showCat("");
    publishTurnAnswer(store, group, group.threadId, bot, since, ask!.id);
    expect(askById(ask!.id)?.state).toBe("done");
    expect(recentRoomEntries(group.hosted.roomId, 10).map((each) => each.text)).not.toContain("Wink couldn't finish this.");
  });

  it("marks a picture-only host answer unread when its turn settles", async () => {
    const unread = turnUnread();
    unread.start(group.threadId, "turn-1", store.rowMark(group.threadId));
    expect((await showCat("")).status).toBe(201);
    expect(unread.settle(group.threadId, "turn-1", (start) => store.rowsSince(group.threadId, start))).toBe(true);
  });

  it("links a picture-only answer to the ask in the room log", async () => {
    const peter = roomPeople(group.hosted.roomId)[0]!;
    const { entry, ask } = hostedSend(group, { kind: "person", id: peter.id }, "@Wink draw a cat");
    expect(startAsk(ask!.id)).toBeTruthy();
    const since = store.messagesFor(group.threadId).length;
    const { bot, body } = await showCat("");
    publishTurnAnswer(store, group, group.threadId, bot, since, ask!.id);
    expect(lastEntry()).toMatchObject({ replyToId: entry.id, askId: ask!.id });
    const rows = store.messagesFor(group.threadId);
    expect(rows.find((message) => message.id === body.messageId)?.replyToId).toBe(rows.find((message) => message.roomEntryId === entry.id)?.id);
  });

  it.each([false, true])("removes the host inline picture when its room file is deleted (legacy %s)", async (legacy) => {
    const { status, body } = await showCat();
    expect(status).toBe(201);
    const roomId = group.hosted.roomId;
    const fileId = lastEntry().files![0]!.id;
    const old = join(ATTACHMENTS_DIR, "old.png");
    if (legacy) {
      writeFileSync(old, PNG);
      store.patchMessage(group.threadId, body.messageId, { image: "old.png", roomFiles: undefined });
    }
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await hostFileRoute({} as IncomingMessage, res as unknown as ServerResponse, "DELETE",
      new URL(`https://localhost/api/rooms/${roomId}/files/${fileId}`), { store, botCaller: false });
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(listRoomFiles(roomId, "Edward").used).toBe(0);
    expect(store.messagesFor(group.threadId).find((message) => message.id === body.messageId)).toMatchObject({
      text: "A cat", roomFiles: [expect.objectContaining({ id: fileId, deleted: true })],
    });
    expect(store.messagesFor(group.threadId).find((message) => message.id === body.messageId)?.image).toBeUndefined();
    expect(existsSync(old)).toBe(false);
  });
});

describe("a host file tag that the composer did not attach", () => {
  const words = (name: string) => `[file: ${name}]`;
  const secret = (folder: string, name: string) => {
    mkdirSync(folder, { recursive: true });
    const path = join(folder, name);
    writeFileSync(path, "-----BEGIN OPENSSH PRIVATE KEY-----");
    return path;
  };

  it("stays as words for a file outside every project and the attachments folder", async () => {
    const outside = mkdtempSync(join(tmpdir(), "host-secret-"));
    try {
      expect((await send(`why ${file(secret(outside, "notes.txt"), "notes.txt")}`)).status).toBe(202);
      expect(lastEntry()).toMatchObject({ text: `why ${words("notes.txt")}` });
      expect(lastEntry().files).toBeUndefined();
      expect(listRoomFiles(group.hosted.roomId, "Edward").files).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stays as words for a dot folder or Wink's data inside a project", async () => {
    store.patchBot(group.memberIds[0]!, { cwd: testHome() });
    const key = secret(join(testHome(), ".ssh"), "id_ed25519");
    const bots = secret(DATA_DIR, "bots.json");
    const keys = secret(join(testHome(), "AppData", "Roaming"), "keys.txt");
    expect((await send([file(key, "id_ed25519"), file(bots, "bots.json"), file(keys, "keys.txt")].join(", "))).status).toBe(202);
    expect(lastEntry()).toMatchObject({ text: [words("id_ed25519"), words("bots.json"), words("keys.txt")].join(", ") });
    expect(listRoomFiles(group.hosted.roomId, "Edward").files).toEqual([]);
  });

  it("never opens a network share", async () => {
    for (const [at, path] of ["\\\\attacker.invalid\\share\\a.txt", "//attacker.invalid/share/a.txt", "\\\\.\\pipe\\wink", "\\\\?\\C:\\a.txt"].entries()) {
      expect((await send(file(path, "a.txt"), `send-share-${at}-0123456789`)).status).toBe(202);
      expect(lastEntry()).toMatchObject({ text: words("a.txt") });
    }
    expect(vi.mocked(open).mock.calls.map(([path]) => path)).toEqual([]);
  });

  it("is refused the same way from a paired phone", async () => {
    const outside = mkdtempSync(join(tmpdir(), "host-secret-"));
    try {
      expect((await send(file(secret(outside, "id_ed25519"), "id_ed25519"), undefined, false, routes(), true)).status).toBe(202);
      expect(lastEntry()).toMatchObject({ text: words("id_ed25519") });
      expect(listRoomFiles(group.hosted.roomId, "Edward").files).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still lets the composer's upload through beside a refused tag", async () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const upload = join(ATTACHMENTS_DIR, "0b9c1d2e-upload.png");
    writeFileSync(upload, PNG);
    store.patchBot(group.memberIds[0]!, { cwd: undefined });
    const outside = mkdtempSync(join(tmpdir(), "host-secret-"));
    try {
      expect((await send(`look ${image(upload)} and ${file(secret(outside, "notes.txt"), "notes.txt")}`)).status).toBe(202);
      expect(lastEntry()).toMatchObject({ text: `look  and ${words("notes.txt")}` });
      expect(lastEntry().files?.map((each) => each.name)).toEqual(["0b9c1d2e-upload.png"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reaches guests through the composer's copy of a desktop file outside every project", async () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const downloads = join(testHome(), "Downloads");
    mkdirSync(downloads, { recursive: true });
    const pdf = join(downloads, "plan.pdf");
    writeFileSync(pdf, PDF);
    const copy = join(ATTACHMENTS_DIR, "5f0c7a1e-plan.pdf");
    writeFileSync(copy, PDF);
    expect((await send(`plan ${file(pdf, "plan.pdf", ` copy="${copy}"`)}`)).status).toBe(202);
    expect(lastEntry()).toMatchObject({ text: "plan" });
    expect(lastEntry().files?.map((each) => [each.name, each.type])).toEqual([["plan.pdf", "application/pdf"]]);
  });

  it("ignores a copy of a private file, and a copy from outside the attachments folder", async () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const copy = join(ATTACHMENTS_DIR, "5f0c7a1e-key.txt");
    writeFileSync(copy, "key");
    const key = secret(join(testHome(), ".ssh"), "id_ed25519");
    const plan = secret(join(testHome(), "Downloads"), "plan.txt");
    const other = secret(join(testHome(), "Documents"), "taxes.txt");
    const share = "\\attacker.invalid\share\a.txt";
    const text = [file(key, "id_ed25519", ` copy="${copy}"`), file(plan, "plan.txt", ` copy="${other}"`), file(share, "a.txt", ` copy="${copy}"`)].join(", ");
    expect((await send(text)).status).toBe(202);
    expect(lastEntry()).toMatchObject({ text: [words("id_ed25519"), words("plan.txt"), words("a.txt")].join(", ") });
    expect(listRoomFiles(group.hosted.roomId, "Edward").files).toEqual([]);
    expect(vi.mocked(open).mock.calls.map(([path]) => path)).toEqual([]);
  });
});
