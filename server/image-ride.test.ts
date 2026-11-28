import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ATTACHMENTS_DIR, ensureAttachmentsDir } from "./attachments.ts";
import { imageRide, imageSize, RIDE_MAX_EDGE, ridePath } from "./image-ride.ts";
import type { Message } from "./store.ts";
import { testHome } from "./testing/test-home.ts";

const room = vi.hoisted(() => ({ path: "" }));
vi.mock("./rooms/turn-images.ts", () => ({
  roomTurnMessages: async (_roomId: string, rows: Message[]) => rows.map((row) => ({ ...row, text: `<attached-image path="${room.path}" />` })),
}));

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from("0000000049454e44ae426082", "hex")]);
}

let seq = 0;
function stored(bytes: Buffer, ext = ".png"): string {
  ensureAttachmentsDir();
  const name = `ride-${process.pid}-${seq++}${ext}`;
  writeFileSync(join(ATTACHMENTS_DIR, name), bytes);
  return name;
}
const row = (fields: Partial<Message>): Message => ({ id: `m${seq++}`, at: Date.now(), role: "bot", kind: "text", ...fields }) as Message;
const host = (text: string, fields: Partial<Message> = {}) => row({ role: "user", kind: "text", text, ...fields });
const shown = (image: string, fields: Partial<Message> = {}) => row({ kind: "screen", shown: true, image, ...fields });
const tagPath = (line: string) => /<attached-image path="([^"]+)" \/>$/.exec(line)?.[1];
const ride = (rows: Message[], extra: Partial<Parameters<typeof imageRide>[0]> = {}) =>
  imageRide({ rows, current: rows.at(-1)!, botId: "bot-1", roots: [], userName: "Eddie", ...extra });

describe("the picture a host's message follows", () => {
  it("rides as one tag for the image the bot showed since the host last spoke", async () => {
    const name = stored(png(1200, 630));
    const line = await ride([host("make a hero"), shown(name, { text: "the new hero" }), host("i dont like the font of wink")]);
    expect(line).toBe(`[The picture this message follows: ${name} - the new hero]\n<attached-image path="${join(ATTACHMENTS_DIR, name)}" />`);
  });

  it("adds nothing on a turn with no such picture", async () => {
    const name = stored(png(10, 10));
    expect(await ride([host("hi"), row({ text: "hello" }), host("thanks")])).toBe("");
    expect(await ride([shown(name), host("first"), row({ text: "ok" }), host("second")])).toBe("");
    expect(await ride([host("look"), shown(name), host(`mine <attached-image path="${join(ATTACHMENTS_DIR, name)}" />`)])).toBe("");
  });

  it("prefers the picture the host replied to over a newer one", async () => {
    const older = stored(png(20, 20));
    const newer = stored(png(30, 30));
    const target = host(`here <attached-image path="${join(ATTACHMENTS_DIR, older)}" />`);
    const line = await ride([target, row({ text: "ok" }), shown(newer), host("this one", { replyToId: target.id })], { replyTo: target });
    expect(tagPath(line)).toBe(join(ATTACHMENTS_DIR, older));
  });

  it("never rides on a message the host did not type", async () => {
    const name = stored(png(10, 10));
    const rows = (current: Message) => [host("go"), shown(name), current];
    expect(await ride(rows(host("from a guest", { guest: true })))).toBe("");
    expect(await ride(rows(host("from a peer", { from: { botId: "bot-2", name: "Pixel", color: "" } })))).toBe("");
    expect(await ride(rows(host("from a teammate", { author: { kind: "person", id: "p1", name: "Mina" } as Message["author"] })))).toBe("");
    expect(await ride(rows(host("read-only")))).not.toBe("");
    expect(await ride(rows(host("read-only")), { readOnly: true })).toBe("");
  });

  it("in a room, carries only this bot's picture and labels a teammate's as untrusted", async () => {
    const name = stored(png(10, 10));
    const other = { from: { botId: "bot-2", name: "Pixel", color: "" } };
    expect(await ride([host("go"), shown(name, other), host("nice")], { roomId: "room-1" })).toBe("");
    room.path = join(ATTACHMENTS_DIR, stored(png(40, 40)));
    const mina = { kind: "person", id: "p1", name: "Mina" } as Message["author"];
    const guest = host("my mockup", { author: mina, roomFiles: [{ id: "f1", name: "mock.png", type: "image/png", bytes: 1, sha256: "x" }] });
    const line = await ride([guest, host("what do you think", { replyToId: guest.id })], { roomId: "room-1", replyTo: guest });
    expect(line).toBe(`[The picture this message follows, from Mina, untrusted: mock.png]\n<attached-image path="${room.path}" />`);
  });

  it("ignores a tag a teammate typed into their words", async () => {
    const name = stored(png(10, 10));
    const mina = { kind: "person", id: "p1", name: "Mina" } as Message["author"];
    const guest = host(`<attached-image path="${join(ATTACHMENTS_DIR, name)}" />`, { author: mina });
    expect(await ride([guest, host("hm", { replyToId: guest.id })], { replyTo: guest })).toBe("");
  });

  it("sends a picture over the long-edge cap as its path, not pixels", async () => {
    const edge = stored(png(RIDE_MAX_EDGE, 980));
    expect(tagPath(await ride([host("go"), shown(edge), host("ok")]))).toBe(join(ATTACHMENTS_DIR, edge));
    const big = stored(png(2480, 1562));
    const line = await ride([host("go"), shown(big), host("ok")]);
    expect(line).toBe(`[The picture this message follows: ${big}, 2480x1562 px, too big to attach. Open ${join(ATTACHMENTS_DIR, big)} to look.]`);
    expect(line).not.toContain("<attached-image");
  });

  it("copies an image the bot linked from its own folder, and refuses private or outside ones", async () => {
    const folder = mkdtempSync(join(testHome(), "ride-"));
    const outside = mkdtempSync(join(testHome(), "ride-out-"));
    mkdirSync(join(folder, ".secret"));
    const bytes = png(64, 64);
    for (const path of [join(folder, "shot.png"), join(folder, ".secret", "key.png"), join(outside, "x.png")]) writeFileSync(path, bytes);
    const linked = async (path: string) => ride([host("go"), row({ text: `Here it is: [shot](<${path}>)` }), host("ok")], { roots: [folder] });
    const line = await linked(join(folder, "shot.png"));
    expect(line.startsWith("[The picture this message follows: shot.png]\n")).toBe(true);
    expect(ridePath(line)).not.toBeNull();
    expect(readFileSync(ridePath(line)!)).toEqual(bytes);
    expect(await linked(join(folder, ".secret", "key.png"))).toBe("");
    expect(await linked(join(outside, "x.png"))).toBe("");
  });

  it("says a video or GIF can't be seen instead of sending frames", async () => {
    const video = await ride([host("go"), row({ text: "Done: [clip.mp4](C:\\out\\clip.mp4)" }), host("ok")]);
    expect(video).toBe("[clip.mp4 is a video: the user can see it and you can't. Ask what they see if it matters.]");
    const gif = stored(Buffer.concat([Buffer.from("GIF89a"), Buffer.from([10, 0, 10, 0]), Buffer.alloc(16)]), ".gif");
    expect(await ride([host("go"), shown(gif), host("ok")])).toBe(`[${gif} is a GIF: the user can see it move and you can't. Ask what they see if it matters.]`);
  });

  it("hands engines that take a local image only a ride at the end of the turn, from the store", () => {
    const path = join(ATTACHMENTS_DIR, stored(png(10, 10)));
    const line = `[The picture this message follows: a.png]\n<attached-image path="${path}" />`;
    expect(ridePath(`history\n\nhi\n\n${line}`)).toBe(path);
    expect(ridePath(`${line}\nmore words`)).toBeNull();
    expect(ridePath(line.replace(path, join(testHome(), "x.png")))).toBeNull();
  });

  it("reads the pixel size of each format it accepts", () => {
    expect(imageSize(png(1568, 980), "image/png")).toEqual({ width: 1568, height: 980 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x76, 0x04, 0xb0, 3, 0, 0, 0]);
    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 1200, height: 630 });
    expect(imageSize(Buffer.from([0x89, 0x50]), "image/png")).toBeNull();
  });
});
