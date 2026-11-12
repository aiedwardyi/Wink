import { afterEach, describe, expect, it, vi } from "vitest";

import type { Group, Message } from "@/state/store-types";

import {
  filesProblem,
  hostLines,
  inviteErrorKey,
  isTeamRoom,
  joinedLines,
  joinedPhase,
  joinedRoomIdOf,
  joinedSelection,
  joinErrorKey,
  joinRoom,
  looksLikeRoomCode,
  ROOM_DOCUMENT_MAX_BYTES as DOCUMENT_MAX_BYTES,
  ROOM_IMAGE_MAX_BYTES as IMAGE_MAX_BYTES,
  roomMessage,
  sendToRoom,
  type JoinedView,
} from "./team-rooms";

const CODE = `wkr1:edward-pc.tail1234.ts.net:inv_mina.wki_${"A".repeat(43)}`;

const group = (patch: Partial<Group>) => ({ id: "g", threadId: "t", name: "Room", memberIds: [], messages: [], ...patch }) as Group;

const view = (status: JoinedView["status"], link: JoinedView["link"]): JoinedView =>
  ({ roomId: "r", status, link, me: { id: "p", name: "Mina" }, state: null });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("team room shape", () => {
  it("is a hosted room with no bots", () => {
    expect(isTeamRoom(group({ hosted: { roomId: "r" } }))).toBe(true);
    expect(isTeamRoom(group({ hosted: { roomId: "r" }, memberIds: ["nova"] }))).toBe(false);
    expect(isTeamRoom(group({}))).toBe(false);
    expect(isTeamRoom(undefined)).toBe(false);
  });

  it("keeps only authored room lines", () => {
    const messages: Message[] = [
      { id: "a", role: "user", kind: "text", text: "hi", at: 1, author: { kind: "person", id: "p", name: "Mina" }, roomEntryId: "e1" },
      { id: "b", role: "bot", kind: "text", text: "system note", at: 2 },
    ];
    expect(hostLines(messages)).toEqual([{ id: "a", entryId: "e1", at: 1, author: { kind: "person", id: "p", name: "Mina" }, text: "hi", files: [], message: messages[0] }]);
    expect(roomMessage(hostLines(messages)[0]!)).toBe(messages[0]);
  });

  it("keeps a bot's room answer after its bot leaves", () => {
    const messages: Message[] = [{ id: "c", role: "bot", kind: "text", text: "On it", at: 3, from: { botId: "wink", name: "Wink", color: "blue" }, roomEntryId: "e3" }];
    expect(hostLines(messages)).toEqual([{ id: "c", entryId: "e3", at: 3, author: { kind: "bot", id: "wink", name: "Wink" }, text: "On it", files: [], color: "blue", message: messages[0] }]);
  });

  it("keeps joined reply ids on the line and its message adapter", () => {
    const entry = { seq: 2, id: "e2", at: 2, author: { kind: "person" as const, id: "mina", name: "Mina Park" }, text: "reply", replyToId: "e1" };
    const line = joinedLines([entry])[0]!;
    expect(line.replyToId).toBe("e1");
    expect(roomMessage(line)).toMatchObject({ id: "e2", roomEntryId: "e2", replyToId: "e1", text: "reply", author: entry.author });
  });

  it("reads joined, link and leave into one phase", () => {
    expect(joinedPhase(view("joined", null))).toBe("connecting");
    expect(joinedPhase(view("joined", "connecting"))).toBe("connecting");
    expect(joinedPhase(view("joined", "live"))).toBe("live");
    expect(joinedPhase(view("joined", "offline"))).toBe("offline");
    expect(joinedPhase(view("removed", "live"))).toBe("removed");
    expect(joinedPhase(view("left", null))).toBe("left");
  });

  it("gives a joined bot line its bot's color, and none to a bot no longer listed", () => {
    const bot = { kind: "bot", id: "b1", name: "Wink" } as const;
    const lines = joinedLines([
      { seq: 1, id: "e1", at: 1, author: bot, text: "on it" },
      { seq: 2, id: "e2", at: 2, author: { ...bot, id: "gone" }, text: "old" },
      { seq: 3, id: "e3", at: 3, author: { kind: "person", id: "p", name: "Mina" }, text: "thanks" },
    ], [{ id: "b1", name: "Wink", color: "blue" }]);
    expect(lines.map((line) => line.color)).toEqual(["blue", undefined, undefined]);
  });

  it("selects a joined room by an id no bot or group can have", () => {
    expect(joinedRoomIdOf(joinedSelection("r9"))).toBe("r9");
    expect(joinedRoomIdOf("nova")).toBeNull();
  });
});

describe("room codes", () => {
  it("knows a code by its shape, ignoring the spaces a paste brings", () => {
    expect(looksLikeRoomCode(CODE)).toBe(true);
    expect(looksLikeRoomCode(`  ${CODE}\n`)).toBe(true);
    expect(looksLikeRoomCode("hello")).toBe(false);
    expect(looksLikeRoomCode(CODE.slice(0, -1))).toBe(false);
    expect(looksLikeRoomCode(CODE.replace("wkr1", "wkr2"))).toBe(false);
  });

  it("maps every refusal to one short line", () => {
    expect(joinErrorKey(409, "room-full")).toBe("teamRoom.full");
    expect(joinErrorKey(429, "busy")).toBe("teamRoom.busy");
    expect(joinErrorKey(503, "unavailable")).toBe("teamRoom.unreachable");
    for (const [status, error] of [[400, "bad-code"], [401, "wrong-secret"], [401, "too-many-tries"], [403, "removed"], [404, "no-invite"], [409, "name-taken"]] as const) {
      expect(joinErrorKey(status, error)).toBe("teamRoom.badCode");
    }
    expect(inviteErrorKey(409)).toBe("teamRoom.phoneOff");
    expect(inviteErrorKey(500)).toBe("errors.request");
  });

  it("joins with the trimmed code and reads a dead link as unreachable", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ room: view("joined", "connecting") })));
    vi.stubGlobal("fetch", fetch);
    expect(await joinRoom(` ${CODE} `)).toEqual({ room: view("joined", "connecting") });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ code: CODE });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await joinRoom(CODE)).toEqual({ status: 503, error: "" });
  });
});

describe("sending to a room", () => {
  const file = (name: string, type: string, size = 3) => new File([new Uint8Array(size)], name, { type });

  it("accepts room limits independently of bot attachments", () => {
    const image = { name: "photo.png", type: "image/png", size: 100 * 1024 ** 2 };
    expect(filesProblem([image])).toBeNull();
    expect(filesProblem([{ ...image, size: 101 * 1024 ** 2 }])?.key).toBe("teamRoom.tooBig");
    expect(filesProblem([{ name: "plan.pdf", type: "application/pdf", size: 1024 ** 3 }])).toBeNull();
    const files = Array.from({ length: 50 }, () => ({ name: "a.txt", type: "text/plain", size: 1 }));
    expect(filesProblem(files)).toBeNull();
    expect(filesProblem([...files, files[0]!])?.key).toBe("teamRoom.tooMany");
  });

  it.each(["/api/rooms/r1", "/api/joined/rooms/r9"])("carries the reply id to %s", async (base) => {
    const fetch = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    expect(await sendToRoom(base, "reply", [], "send-0123456789abcdef", "original-entry")).toBeNull();
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({ text: "reply", sendId: "send-0123456789abcdef", replyToId: "original-entry" });
  });

  it("refuses too many or too big before any upload", () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ name: `${index}.txt`, size: 1, type: "text/plain" }));
    expect(filesProblem(many)).toEqual({ key: "teamRoom.tooMany" });
    expect(filesProblem([{ name: "huge.png", size: IMAGE_MAX_BYTES + 1, type: "image/png" }])).toEqual({ key: "teamRoom.tooBig", vars: { name: "huge.png" } });
    expect(filesProblem([{ name: "plan.pdf", size: DOCUMENT_MAX_BYTES, type: "application/pdf" }])).toBeNull();
  });

  it("uploads each file, then sends one message with their ids", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
      paths.push(path);
      bodies.push(init.body);
      return new Response(JSON.stringify(path.includes("/files?") ? { file: { id: `id-${paths.length}` } } : { ok: true }));
    }));
    expect(await sendToRoom("/api/rooms/r1", "look", [file("a.png", "image/png"), file("b.pdf", "application/pdf")], "send-0123456789abcdef")).toBeNull();
    expect(paths.map((path) => path.split("&")[0])).toEqual(["/api/rooms/r1/files?name=a.png", "/api/rooms/r1/files?name=b.pdf", "/api/rooms/r1/send"]);
    expect(JSON.parse(String(bodies[2]))).toEqual({ text: "look", sendId: "send-0123456789abcdef", fileIds: ["id-1", "id-2"] });
  });

  it("sends text alone without file ids", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ ok: true }));
    }));
    expect(await sendToRoom("/api/joined/rooms/r9", "hi", [], "send-0123456789abcdef")).toBeNull();
    expect(JSON.parse(String(bodies[0]))).toEqual({ text: "hi", sendId: "send-0123456789abcdef" });
  });

  it("names what went wrong and never sends after a refused upload", async () => {
    for (const [status, problem] of [
      [413, { key: "teamRoom.tooBig", vars: { name: "a.png" } }],
      [415, { key: "teamRoom.fileType" }],
      [429, { key: "teamRoom.tooFast" }],
      [500, { key: "teamRoom.sendFailed" }],
    ] as const) {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status }));
      vi.stubGlobal("fetch", fetch);
      expect(await sendToRoom("/api/rooms/r1", "", [file("a.png", "image/png")], "send-0123456789abcdef")).toEqual(problem);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await sendToRoom("/api/rooms/r1", "hi", [], "send-0123456789abcdef")).toEqual({ key: "teamRoom.sendFailed" });
  });

  it("names a refused bot request", async () => {
    for (const [error, key] of [["wait for your last request to finish", "teamRoom.askBusy"], ["you've asked the bot the most it takes in an hour", "teamRoom.askLimit"]]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error }), { status: 429 })));
      expect(await sendToRoom("/api/joined/rooms/r9", "@Wink hi", [], "send-0123456789abcdef")).toEqual({ key });
    }
  });

  it("uploads only the files a failed send didn't finish when it is retried", async () => {
    const files = [file("a.png", "image/png"), file("b.pdf", "application/pdf")];
    const uploads: string[] = [];
    let failB = true;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (!path.includes("/files?")) return Response.json({ ok: true });
      const query = new URLSearchParams(path.split("?")[1]);
      uploads.push(`${query.get("name")} ${query.get("uploadId")}`);
      if (query.get("name") === "b.pdf" && failB) return Response.json({ error: "no" }, { status: 500 });
      return Response.json({ file: { id: `id-${query.get("name")}` } });
    }));
    expect(await sendToRoom("/api/rooms/r1", "look", files, "send-0123456789abcdef")).toEqual({ key: "teamRoom.sendFailed" });
    failB = false;
    expect(await sendToRoom("/api/rooms/r1", "look", files, "send-0123456789abcdef")).toBeNull();
    expect(uploads.map((line) => line.split(" ")[0])).toEqual(["a.png", "b.pdf", "b.pdf"]);
    expect(uploads[2]!.split(" ")[1]).toBe(uploads[1]!.split(" ")[1]);
  });

  it("uploads again once the room no longer has a file it took", async () => {
    const files = [file("a.png", "image/png")];
    let uploads = 0;
    let gone = false;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.includes("/files?")) return Response.json({ file: { id: `id-${++uploads}` } });
      return gone ? Response.json({ error: "no such file in this room" }, { status: 404 }) : Response.json({ ok: true });
    }));
    expect(await sendToRoom("/api/rooms/r1", "", files, "send-0123456789abcdef")).toBeNull();
    gone = true;
    expect(await sendToRoom("/api/rooms/r1", "", files, "send-0123456789abcdef")).toEqual({ key: "teamRoom.sendFailed" });
    gone = false;
    expect(await sendToRoom("/api/rooms/r1", "", files, "send-0123456789abcdef")).toBeNull();
    expect(uploads).toBe(2);
  });
});
