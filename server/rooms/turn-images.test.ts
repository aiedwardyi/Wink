import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ATTACHMENTS_DIR } from "../attachments.ts";
import { DATA_DIR } from "../config.ts";
import type { Message } from "../store.ts";
import { closeRoomsDb, createRoom } from "./db.ts";
import { deleteRoomFile, saveRoomFile } from "./files.ts";
import { moveRoomFiles, roomFilesRoot } from "./files-folder.ts";
import { roomTurnMessages } from "./turn-images.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(1)]);
let roomId: string;

beforeEach(() => {
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  roomId = createRoom("Images").id;
});

afterEach(closeRoomsDb);

async function message(text = "look", bytes = png): Promise<Message> {
  const req = Object.assign(Readable.from([bytes]), { headers: { "content-length": String(bytes.length) } }) as IncomingMessage;
  const file = await saveRoomFile(req, roomId, { owner: "host", name: "image.png", uploadId: `room-image-${Date.now()}` });
  return { id: "m1", role: "user", kind: "text", text, at: Date.now(), roomFiles: [file] };
}

const imagePath = (row: Message) => /<attached-image path="([^"]+)"\s*\/>/.exec(row.text ?? "")?.[1];

it("adds attachment-store images to model context without changing stored messages", async () => {
  const row = await message();
  const [prepared] = await roomTurnMessages(roomId, [row]);
  expect(row.text).toBe("look");
  expect(prepared!.text).toContain("look\n<attached-image");
  expect(dirname(imagePath(prepared!)!)).toBe(ATTACHMENTS_DIR);
  expect(readFileSync(imagePath(prepared!)!)).toEqual(png);
  expect(imagePath((await roomTurnMessages(roomId, [row]))[0]!)).toBe(imagePath(prepared!));
  expect(readdirSync(ATTACHMENTS_DIR)).toHaveLength(1);
});

it("keeps image-only messages in the model transcript", async () => {
  expect(imagePath((await roomTurnMessages(roomId, [await message("")]))[0]!)).toBeDefined();
});

it("does not attach deleted, missing or cross-room images, even after caching", async () => {
  const row = await message();
  expect(imagePath((await roomTurnMessages(roomId, [row]))[0]!)).toBeDefined();
  expect(await roomTurnMessages(createRoom("Other").id, [row])).toEqual([row]);
  expect(await roomTurnMessages(roomId, [{ ...row, roomFiles: [{ ...row.roomFiles![0]!, deleted: true }] }])).toEqual([{ ...row, roomFiles: [{ ...row.roomFiles![0]!, deleted: true }] }]);
  await deleteRoomFile(roomId, row.roomFiles![0]!.id);
  expect(await roomTurnMessages(roomId, [row])).toEqual([row]);
});

it("reads the configured room folder after a move", async () => {
  const row = await message();
  await moveRoomFiles(join(DATA_DIR, "Documents"));
  expect(readFileSync(imagePath((await roomTurnMessages(roomId, [row]))[0]!)!)).toEqual(png);
});

it("skips unavailable blobs without losing the message", async () => {
  const row = await message();
  unlinkSync(join(roomFilesRoot(), roomId, row.roomFiles![0]!.id));
  expect(await roomTurnMessages(roomId, [row])).toEqual([row]);
});

it("keeps the conversation when its configured file drive is unavailable", async () => {
  const row = await message();
  writeFileSync(join(DATA_DIR, "room-files-folder.json"), JSON.stringify({ path: join(DATA_DIR, "missing") }));
  expect(await roomTurnMessages(roomId, [row])).toEqual([row]);
});

it.skipIf(process.platform === "win32")("does not follow a blob link outside the room folder", async () => {
  const row = await message();
  const blob = join(roomFilesRoot(), roomId, row.roomFiles![0]!.id);
  const outside = join(DATA_DIR, "outside.png");
  writeFileSync(outside, png);
  unlinkSync(blob);
  symlinkSync(outside, blob);
  expect(await roomTurnMessages(roomId, [row])).toEqual([row]);
});

it("leaves ordinary groups and non-image files alone", async () => {
  const row = await message("notes", Buffer.from("plain text"));
  expect(await roomTurnMessages(roomId, [row])).toEqual([row]);
  expect(await roomTurnMessages(undefined, [row])).toEqual([row]);
});
