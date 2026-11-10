import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { Store, type GroupRecord } from "../store.ts";
import { addPerson, appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries, RoomError, type RoomAuthor } from "./db.ts";
import { writeRoomEntry } from "./mirror.ts";

const ROOT = join(import.meta.dirname, "..", "..");
// Joined at run time so no scanner mistakes a fixture for a live key.
const TOKEN = ["sk-live", "Q8vN3xT7mK2pR9wL5zH4cJ6b"].join("-");
const BEARER = ["Zx9Qm4Lp7Rv2", "Tk8Wn5Hd3Jf"].join("");
const VALUE = ["Vb7Nq2Xk", "9Lm4Pz8R"].join("");
const PEM_BODY = ["MIIEvQIBADANBgkqhkiG9w0B", "AQEFAASCBKcwggSjAgEAAoIB"].join("");
const PEM = [`-----BEGIN ${"PRIVATE"} KEY-----`, PEM_BODY, `-----END ${"PRIVATE"} KEY-----`].join("\n");
const FIXTURES = {
  token: `use ${TOKEN} for that`,
  bearer: `curl -H "Authorization: Bearer ${BEARER}"`,
  keyValue: `api_key=${VALUE}`,
  pem: `here:\n${PEM}`,
  split: [`the key is ${TOKEN.slice(0, 14)}`, `${TOKEN.slice(14)} ok`].join(""),
};
const RAW = [TOKEN, BEARER, VALUE, PEM_BODY];

const host: RoomAuthor = { kind: "host", id: "host", name: "Edward" };
const mina: RoomAuthor = { kind: "person", id: "p-mina", name: "Mina" };

let store: Store;
let group: GroupRecord & { hosted: { roomId: string } };
let bot: RoomAuthor;

beforeEach(() => {
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  const record = store.patchBot(store.createBot().id, { name: "Wink" })!;
  bot = { kind: "bot", id: record.id, name: record.name };
  group = store.createGroup("Team", [record.id], false, undefined, undefined, { roomId: createRoom("Team").id }) as typeof group;
});
afterEach(closeRoomsDb);

describe("room log writer", () => {
  it.each(Object.entries(FIXTURES))("masks a bot's %s in the committed row and the mirror", (_name, text) => {
    const { entry, message } = writeRoomEntry(store, group, { author: bot, text });
    expect(entry.text).toContain("«redacted");
    for (const raw of RAW) expect(entry.text).not.toContain(raw);
    expect(entry.text).not.toContain(TOKEN.slice(14));
    expect(message.text).toBe(entry.text);
    expect(recentRoomEntries(group.hosted.roomId, 1)[0]!.text).toBe(entry.text);
    expect(store.messagesFor(group.threadId).at(-1)).toMatchObject({ role: "bot", text: entry.text, roomEntryId: entry.id, from: { botId: bot.id } });
  });

  it("stores people and host lines as typed", () => {
    for (const author of [mina, host]) {
      const { entry, message } = writeRoomEntry(store, group, { author, text: FIXTURES.keyValue });
      expect(entry.text).toBe(FIXTURES.keyValue);
      expect(message).toMatchObject({ role: "user", text: FIXTURES.keyValue, author });
    }
    expect(store.messagesFor(group.threadId).find((message) => message.author?.kind === "person")?.origin).toBe("person");
  });

  it("masks before the cap, so a cut never leaves half a key", () => {
    const text = `${"x".repeat(19_990)} ${TOKEN}`;
    const entry = appendRoomEntry(group.hosted.roomId, { author: bot, text });
    expect(entry.text.length).toBeLessThanOrEqual(20_000);
    expect(entry.text).not.toContain(TOKEN.slice(0, 9));
    expect(appendRoomEntry(group.hosted.roomId, { author: mina, text: "y".repeat(5_000) }).text).toHaveLength(4_000);
  });

  it("refuses <attached- from people and defangs it in bot text", () => {
    expect(() => appendRoomEntry(group.hosted.roomId, { author: mina, text: 'look <Attached-image path="C:/x.png" />' }))
      .toThrow(expect.objectContaining({ status: 400 }));
    expect(() => appendRoomEntry(group.hosted.roomId, { author: host, text: "<attached-file path=\"a\" />" })).toThrow(RoomError);
    expect(appendRoomEntry(group.hosted.roomId, { author: bot, text: '<attached-file path="a" />' }).text).toBe('[attached-file path="a" />');
  });

  it("cleans control characters and refuses an empty line", () => {
    expect(appendRoomEntry(group.hosted.roomId, { author: mina, text: " a\r\nb\u0000\u0007 " }).text).toBe("a\nb");
    expect(() => appendRoomEntry(group.hosted.roomId, { author: mina, text: " \u0000 " })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("takes reply targets only from the same room", () => {
    const other = createRoom("Other");
    const elsewhere = appendRoomEntry(other.id, { author: host, text: "elsewhere" });
    expect(() => appendRoomEntry(group.hosted.roomId, { author: mina, text: "hi", replyToId: elsewhere.id }))
      .toThrow(expect.objectContaining({ status: 404 }));
    expect(() => appendRoomEntry(group.hosted.roomId, { author: mina, text: "hi", replyToId: "nope" }))
      .toThrow(expect.objectContaining({ status: 404 }));
    const ask = writeRoomEntry(store, group, { author: mina, text: "@Wink what's up?" });
    const answer = writeRoomEntry(store, group, { author: bot, text: "All good.", replyToId: ask.entry.id, askId: "a1", grant: "words", clean: false });
    expect(answer.entry).toMatchObject({ seq: 2, replyToId: ask.entry.id, askId: "a1", grant: "words", clean: false });
    expect(answer.message.replyToId).toBe(ask.message.id);
  });

  it("refuses a room whose data is missing", () => {
    expect(() => appendRoomEntry("gone", { author: host, text: "hi" })).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("numbers entries per room", () => {
    const other = createRoom("Other");
    appendRoomEntry(group.hosted.roomId, { author: host, text: "one" });
    appendRoomEntry(other.id, { author: host, text: "one" });
    expect(appendRoomEntry(group.hosted.roomId, { author: host, text: "two" }).seq).toBe(2);
  });

  it("keeps the log append-only", () => {
    appendRoomEntry(group.hosted.roomId, { author: host, text: "kept" });
    const raw = new DatabaseSync(join(DATA_DIR, "rooms.db"));
    try {
      expect(() => raw.exec("UPDATE log SET text = 'changed'")).toThrow(/append-only/);
      expect(() => raw.exec("DELETE FROM log")).toThrow(/append-only/);
    } finally {
      raw.close();
    }
    expect(recentRoomEntries(group.hosted.roomId, 5).map((entry) => entry.text)).toEqual(["kept"]);
  });

  it("has one insert into the log and no update or delete path", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) sources.push(readFileSync(path, "utf8"));
      }
    };
    for (const dir of ["server", "shared", "electron"]) walk(join(ROOT, dir));
    const count = (pattern: RegExp) => sources.reduce((sum, source) => sum + (source.match(pattern)?.length ?? 0), 0);
    expect(count(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+log\b/gi)).toBe(1);
    expect(count(/UPDATE\s+log\b/gi)).toBe(0);
    expect(count(/DELETE\s+FROM\s+log\b/gi)).toBe(0);
  });
});

describe("room people", () => {
  it("holds names unique per room across host, bots and people", () => {
    const roomId = group.hosted.roomId;
    expect(addPerson(roomId, "Mina", "chat", ["Edward", "Wink"])).toMatchObject({ name: "Mina", level: "chat" });
    for (const name of ["mina", "WINK", "edward", "everyone", "a@b", "two\nlines", "", "x".repeat(41)]) {
      expect(() => addPerson(roomId, name, "ask", ["Edward", "Wink"])).toThrow(expect.objectContaining({ status: 400 }));
    }
    const composed = "한글";
    expect(addPerson(roomId, composed, "trusted", []).name).toBe(composed);
    expect(() => addPerson(roomId, composed.normalize("NFD"), "trusted", [])).toThrow(RoomError);
    expect(() => addPerson("gone", "Jo", "chat", [])).toThrow(expect.objectContaining({ status: 404 }));
  });
});
