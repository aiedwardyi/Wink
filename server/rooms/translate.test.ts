import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { json } from "../http-helpers.ts";
import { relayVerdict } from "../phone-auth.ts";
import type { Message } from "../store.ts";
import { addPerson, appendRoomEntry, closeRoomsDb, createRoom, saveRoomTranslation } from "./db.ts";
import { addJoinedEntries, closeJoinedDb, resetJoined, saveJoined, saveJoinedTranslation, setJoinedState } from "./joined.ts";
import { createPeopleOnlyRoom } from "./people-only.ts";

const modulePath = "./translate.ts";
const translate = existsSync(join(import.meta.dirname, modulePath)) ? await import(modulePath) : null;
const generateText = vi.fn(async (..._args: unknown[]) => "The launch is ready.");
const groups: Array<{ hosted: { roomId: string }; memberIds: string[]; threadId?: string }> = [];
const messages = new Map<string, Message[]>();
const instances = [{ driverKind: "claudeAgent", enabled: true, generateText }];
let server: Server;
let base: string;
let roomId: string;
let entryId: string;

beforeAll(async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  server = createServer(async (req, res) => {
    if (await translate?.translateRoute(req, res, req.method!, req.url!, {
      store: { groups, messagesFor: (threadId: string) => messages.get(threadId) ?? [] }, instances, key: "", hostName: "Edward", botCaller: req.headers.authorization === "Bearer bot",
    })) return;
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  generateText.mockReset().mockResolvedValue("The launch is ready.");
  instances[0]!.enabled = true;
  messages.clear();
  roomId = createPeopleOnlyRoom("Private room title").id;
  groups.push({ hosted: { roomId }, memberIds: [] });
  entryId = appendRoomEntry(roomId, { author: { kind: "person", id: "p1", name: "Private name" }, text: "출시 준비 끝났어요." }).id;
});

afterEach(() => { closeRoomsDb(); closeJoinedDb(); });
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

async function call(path: string, lang: unknown = "en", bot = false) {
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(bot ? { authorization: "Bearer bot" } : {}) }, body: JSON.stringify({ lang }),
  });
  return { status: response.status, body: await response.json() };
}

const hostPath = () => `/api/rooms/${roomId}/entries/${entryId}/translate`;
const joinedPath = () => `/api/joined/rooms/${roomId}/entries/${entryId}/translate`;

function joinRoom() {
  saveJoined(roomId, "unreachable.example", { id: "me", name: "Viewer" }, "private-guest-key");
  addJoinedEntries(roomId, [{ seq: 1, id: entryId, at: Date.now(), author: { kind: "host", id: "host", name: "Private host" }, text: "출시 준비 끝났어요." }]);
}

describe("room translation", () => {
  it("translates each hosted bubble independently without a committed entry link", async () => {
    groups.find((group) => group.hosted.roomId === roomId)!.threadId = "held-thread";
    const first: Message = { id: "first", role: "bot", kind: "text", at: Date.now(), text: "준비를 모두 마쳤어요.", from: { botId: "b1", name: "Rando", color: "blue" } };
    messages.set("held-thread", [first, { ...first, id: "last", text: "For Eddie: ready.", roomEntryId: entryId }]);
    const path = `/api/rooms/${roomId}/entries/m-first/translate`;
    expect((await call(path)).status).toBe(200);
    expect(String(generateText.mock.calls[0]?.[0])).toContain(first.text);
    expect(String(generateText.mock.calls[0]?.[0])).not.toContain("For Eddie");
    closeRoomsDb();
    expect((await call(path)).status).toBe(200);
    expect(generateText).toHaveBeenCalledTimes(1);
    first.text = "내용을 수정했어요.";
    generateText.mockResolvedValue("The content has changed.");
    expect((await call(path)).body).toEqual({ text: "The content has changed." });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("keeps local bubble lookup inside the held room and refuses bot callers", async () => {
    groups.find((group) => group.hosted.roomId === roomId)!.threadId = "held-thread";
    const bot: Message = { id: "private", role: "bot", kind: "text", at: Date.now(), text: "비공개 대화", from: { botId: "b1", name: "Rando", color: "blue" } };
    messages.set("private-thread", [bot]);
    const path = `/api/rooms/${roomId}/entries/m-private/translate`;
    expect((await call(path)).status).toBe(404);
    messages.set("held-thread", [{ ...bot, role: "user" }]);
    expect((await call(path)).status).toBe(404);
    messages.set("held-thread", [bot]);
    expect((await call(path, "en", true)).status).toBe(403);
    joinRoom();
    expect((await call(path.replace("/api/rooms/", "/api/joined/rooms/"))).status).toBe(404);
    expect(generateText).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores romanized member names and replaces legacy cache: joined=%s", async (joined) => {
    addPerson(roomId, "이서연", "chat", []);
    addPerson(roomId, "Unmentioned Person", "chat", []);
    entryId = appendRoomEntry(roomId, { author: { kind: "person", id: "p1", name: "Mina" }, text: "이서연님, 준비됐어요." }).id;
    if (joined) {
      joinRoom();
      resetJoined(roomId);
      setJoinedState(roomId, { version: 1, roomName: "Private title", instructions: "", host: "Host", me: { id: "me", name: "Viewer" }, people: [{ id: "p2", name: "이서연" }, { id: "p3", name: "Unmentioned Person" }], bots: [] });
      addJoinedEntries(roomId, [{ seq: 1, id: entryId, at: Date.now(), author: { kind: "host", id: "host", name: "Host" }, text: "이서연님, 준비됐어요." }]);
    }
    (joined ? saveJoinedTranslation : saveRoomTranslation)(roomId, entryId, "en", "Lee Seoyeon, ready.");
    generateText.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[0]);
      const name = prompt.match(/<name_[a-f0-9]+_\d+>이서연<\/name_[^>]+>/)?.[0] ?? "이서연";
      return `${name.replace("이서연", "Lee Seoyeon")}, ready.`;
    });
    const path = joined ? joinedPath() : hostPath();
    expect(await call(path)).toEqual({ status: 200, body: { text: "이서연, ready." } });
    const prompt = String(generateText.mock.calls[0]?.[0]);
    expect(prompt).toContain("Never translate, transliterate or romanize people's names");
    expect(prompt).not.toContain("Unmentioned Person");
    expect(prompt).not.toContain("Private title");
    closeRoomsDb();
    closeJoinedDb();
    expect((await call(path)).body).toEqual({ text: "이서연, ready." });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("rejects lost name markers and retries without caching altered names", async () => {
    entryId = appendRoomEntry(roomId, { author: { kind: "person", id: "p1", name: "이서연" }, text: "이서연입니다." }).id;
    generateText.mockResolvedValue("I am Lee Seoyeon.");
    expect(await call(hostPath())).toEqual({ status: 502, body: { error: "translation failed" } });
    generateText.mockImplementation(async (...args: unknown[]) => String(args[0]).match(/<message>\n([\s\S]*)\n<\/message>/)![1]!);
    expect((await call(hostPath())).body).toEqual({ text: "이서연입니다." });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("restores repeated and overlapping names without changing mentions or suffixes", async () => {
    addPerson(roomId, "서연", "chat", []);
    addPerson(roomId, "Mina Park", "chat", []);
    const text = "@이서연님, 서연, Mina Park, 이서연.";
    entryId = appendRoomEntry(roomId, { author: { kind: "person", id: "p1", name: "이서연" }, text }).id;
    generateText.mockImplementation(async (...args: unknown[]) => String(args[0]).match(/<message>\n([\s\S]*)\n<\/message>/)![1]!
      .replaceAll("이서연", "Lee Seoyeon").replaceAll("서연", "Seoyeon").replaceAll("Mina Park", "박민아"));
    expect((await call(hostPath())).body).toEqual({ text });
  });

  it("protects the host name supplied by the viewer's profile", async () => {
    entryId = appendRoomEntry(roomId, { author: { kind: "person", id: "p1", name: "Mina" }, text: "Edward, 감사합니다." }).id;
    generateText.mockImplementation(async (...args: unknown[]) => String(args[0]).match(/<message>\n([\s\S]*)\n<\/message>/)![1]!.replace("Edward", "에드워드"));
    expect((await call(hostPath())).body).toEqual({ text: "Edward, 감사합니다." });
  });

  it("translates a host's held teammate line", async () => {
    expect(await call(hostPath())).toEqual({ status: 200, body: { text: "The launch is ready." } });
  });

  it("shares one generation across simultaneous taps, reload and phone, per language", async () => {
    generateText.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return "Ready"; });
    const replies = await Promise.all([call(hostPath()), call(hostPath())]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    closeRoomsDb();
    expect((await call(hostPath())).body).toEqual({ text: "Ready" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect((await call(hostPath(), "ko")).status).toBe(200);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("translates a joined line locally and keeps it across reload and a file delete reset", async () => {
    joinRoom();
    expect((await call(joinedPath())).status).toBe(200);
    closeJoinedDb();
    expect((await call(joinedPath())).status).toBe(200);
    expect(generateText).toHaveBeenCalledTimes(1);
    resetJoined(roomId);
    expect((await call(joinedPath())).status).toBe(404);
    addJoinedEntries(roomId, [{ seq: 1, id: entryId, at: Date.now(), author: { kind: "host", id: "host", name: "Private host" }, text: "출시 준비 끝났어요." }]);
    expect((await call(joinedPath())).status).toBe(200);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("translates a teammate line in a shared bot group", async () => {
    roomId = createRoom("Shared group").id;
    groups.push({ hosted: { roomId }, memberIds: ["bot-1"] });
    entryId = appendRoomEntry(roomId, { author: { kind: "person", id: "p1", name: "Mina" }, text: "출시 준비 끝났어요." }).id;
    expect(await call(hostPath())).toEqual({ status: 200, body: { text: "The launch is ready." } });
  });

  it.each([false, true])("translates host and teammate bot entries locally: joined=%s", async (joined) => {
    roomId = createRoom("Shared group").id;
    groups.push({ hosted: { roomId }, memberIds: ["bot-1"] });
    if (joined) saveJoined(roomId, "unreachable.example", { id: "me", name: "Viewer" }, "private-guest-key");
    for (const owner of [undefined, "me", "p1"]) {
      const entry = appendRoomEntry(roomId, { author: { kind: "bot", id: "bot-1", name: "Rando", ...(owner ? { owner } : {}) }, text: "출시 준비를 모두 마쳤어요. (For Eddie: ready)" });
      entryId = entry.id;
      if (joined) addJoinedEntries(roomId, [entry]);
      const path = joined ? joinedPath() : hostPath();
      expect(await call(path)).toEqual({ status: 200, body: { text: "The launch is ready." } });
      closeRoomsDb();
      closeJoinedDb();
      expect((await call(path)).status).toBe(200);
    }
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it("sends only the selected line and uses an isolated text call", async () => {
    appendRoomEntry(roomId, { author: { kind: "person", id: "p2", name: "Another name" }, text: "Another private line" });
    expect((await call(hostPath())).status).toBe(200);
    expect(generateText).toHaveBeenCalledWith(
      "Translate the chat message between the <message> tags into English. Reply with only the translation. Keep names, @mentions, code, links, numbers, emoji and line breaks as they are. Never translate, transliterate or romanize people's names. Copy each name_ element exactly once with its tags and enclosed name unchanged.\n<message>\n출시 준비 끝났어요.\n</message>",
      expect.objectContaining({ timeoutMs: 30_000, lean: true, ephemeral: true, signal: expect.any(AbortSignal) }),
    );
  });

  it("refuses bot callers on both routes before generation", async () => {
    joinRoom();
    for (const path of [hostPath(), joinedPath()]) expect((await call(path, "en", true)).status).toBe(403);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("refuses invalid languages, foreign entries and own host lines", async () => {
    expect((await call(hostPath(), "ja")).status).toBe(400);
    expect((await call(hostPath().replace(entryId, "foreign"))).status).toBe(404);
    entryId = appendRoomEntry(roomId, { author: { kind: "host", id: "host", name: "Me" }, text: "Own line" }).id;
    expect((await call(hostPath())).status).toBe(404);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("reports no engine and never generates", async () => {
    instances[0]!.enabled = false;
    const response = await fetch(`${base}/api/rooms/${roomId}/translate`);
    expect(await response.json()).toEqual({ available: false });
    expect((await call(hostPath())).status).toBe(503);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("retries failures without saving an empty or failed result", async () => {
    generateText.mockRejectedValueOnce(new Error("private provider detail"));
    expect(await call(hostPath())).toEqual({ status: 502, body: { error: "translation failed" } });
    expect((await call(hostPath())).status).toBe(200);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("runs at most two distinct lines at once across both databases", async () => {
    joinRoom();
    const second = appendRoomEntry(roomId, { author: { kind: "person", id: "p1", name: "Mina" }, text: "다음 메시지" });
    let active = 0;
    let peak = 0;
    generateText.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active--;
      return "Ready";
    });
    const replies = await Promise.all([call(hostPath()), call(joinedPath()), call(hostPath().replace(entryId, second.id)), call(hostPath(), "ko")]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
    expect(peak).toBe(2);
    expect(generateText).toHaveBeenCalledTimes(4);
  });

  it("does not restore a joined translation after its local copy is reset", async () => {
    joinRoom();
    let release!: (text: string) => void;
    generateText.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = call(joinedPath());
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    resetJoined(roomId);
    release("Ready");
    expect((await pending).status).toBe(404);
    joinRoom();
    generateText.mockResolvedValue("Fresh");
    expect((await call(joinedPath())).body).toEqual({ text: "Fresh" });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("aborts at thirty seconds and permits a fresh retry", async () => {
    const original = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === 30_000) expire = callback;
      return Reflect.apply(original, globalThis, [callback, ms, ...args]);
    }) as typeof setTimeout);
    generateText.mockImplementation((...args: unknown[]) => new Promise((_resolve, reject) => {
      const signal = (args[1] as { signal: AbortSignal }).signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    try {
      const pending = call(hostPath());
      await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
      expect(expire).toBeTypeOf("function");
      expire!();
      expect(await pending).toEqual({ status: 502, body: { error: "translation failed" } });
      generateText.mockResolvedValue("Retry ready");
      expect((await call(hostPath())).body).toEqual({ text: "Retry ready" });
    } finally { timer.mockRestore(); }
  });

  it("reaches the phone session check on the relay for both routes", () => {
    for (const url of [hostPath(), joinedPath()]) {
      expect(relayVerdict({ method: "POST", url, rawHeaders: ["host", "pc.wink.test", "origin", "https://pc.wink.test"] }, "pc.wink.test").kind).toBe("app");
    }
  });

  it("mounts before catch-all room routes with bot-token refusal", () => {
    const source = readFileSync(join(import.meta.dirname, "../index.ts"), "utf8");
    const start = source.indexOf("await translateRoute(");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(source.indexOf("await joinedFileRoute("));
    expect(source.slice(start, source.indexOf("\n", start))).toContain("botCaller: Boolean(commsCallers.resolve(req.headers.authorization))");
  });
});

describe("translation engine", () => {
  it("uses another engine when Codex has only unsupported custom models", async () => {
    const codex = { driverKind: "codex", enabled: true, generateText: vi.fn(), models: { default: "local::nano", options: [{ id: "local::nano", custom: true }] } };
    const other = { driverKind: "other", enabled: true, generateText: vi.fn(async () => "Ready") };
    expect(await translate?.translationGenerator("", [codex, other])?.("line", new AbortController().signal)).toBe("Ready");
    expect(codex.generateText).not.toHaveBeenCalled();
    expect(translate?.translationGenerator("", [codex])).toBeNull();
  });

  it.each([{ id: "nano-custom", custom: true }, { id: "local::nano" }])("skips unsupported Codex models: %j", async (custom) => {
    const generateText = vi.fn(async () => "Ready");
    const codex = { driverKind: "codex", enabled: true, generateText, models: { default: custom.id, options: [custom, { id: "gpt-mini" }] } };
    await translate?.translationGenerator("", [codex])?.("line", new AbortController().signal);
    expect(generateText).toHaveBeenCalledWith("line", expect.objectContaining({ model: "gpt-mini" }));
  });

  it("uses the saved Gemini key before an enabled AI login", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "준비됐어요." }] } }] })));
    const generate = translate?.translationGenerator("saved-key", instances, fetch);
    expect(generate).toBeTypeOf("function");
    expect(await generate("Only this line", new AbortController().signal)).toBe("준비됐어요.");
    expect(generateText).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(":generateContent"), expect.objectContaining({
      headers: { "content-type": "application/json", "x-goog-api-key": "saved-key" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Only this line" }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 4096 } }),
    }));
  });

  it("prefers Claude, then a small Codex model, then another enabled text engine", async () => {
    const other = { driverKind: "grokAgent", enabled: true, generateText: vi.fn(async () => "other") };
    const codex = { driverKind: "codex", enabled: true, generateText: vi.fn(async () => "codex"), models: { default: "gpt-large", options: [{ id: "gpt-large" }, { id: "gpt-mini" }] } };
    const claude = { driverKind: "claudeAgent", enabled: true, generateText: vi.fn(async () => "claude") };
    const signal = new AbortController().signal;
    expect(await translate?.translationGenerator("", [other, codex, claude])?.("line", signal)).toBe("claude");
    claude.enabled = false;
    expect(await translate?.translationGenerator("", [other, codex, claude])?.("line", signal)).toBe("codex");
    expect(codex.generateText).toHaveBeenCalledWith("line", expect.objectContaining({ model: "gpt-mini", lean: true, ephemeral: true }));
    codex.enabled = false;
    expect(await translate?.translationGenerator("", [other, codex, claude])?.("line", signal)).toBe("other");
    other.enabled = false;
    expect(translate?.translationGenerator("", [other, codex, claude])).toBeNull();
  });

  it("uses the viewer's Main account and hides signed-out or blocked engines", () => {
    const profile = { instanceId: "claude", driverKind: "claudeAgent", enabled: true, generateText };
    const account = { ...profile, instanceId: "acct-main", account: { id: "acct-main" } };
    const registry = {
      instances: () => [profile, account], get: () => account, accountBlocked: vi.fn(() => false),
      describeSaved: () => [{ instanceId: "acct-main", snapshot: { state: "available", authenticated: true } }],
    };
    const accounts = { mainAccount: vi.fn((): { id: string } | null => ({ id: "acct-main" })) };
    expect(translate?.translationInstances(registry, accounts)).toEqual([account]);
    registry.accountBlocked.mockReturnValue(true);
    expect(translate?.translationInstances(registry, accounts)).toEqual([]);
    registry.accountBlocked.mockReturnValue(false);
    accounts.mainAccount.mockReturnValue(null);
    expect(translate?.translationInstances(registry, accounts)).toEqual([]);
    accounts.mainAccount.mockReturnValue({ id: "acct-main" });
    registry.describeSaved = () => [{ instanceId: "acct-main", snapshot: { state: "unavailable", authenticated: false } }];
    expect(translate?.translationInstances(registry, accounts)).toEqual([]);
  });
});
