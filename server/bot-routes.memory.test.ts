import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createBotRoutes } from "./bot-routes.ts";
import { DATA_DIR } from "./config.ts";
import { createMemoryHealthCheck } from "./memory-health.ts";
import { markTalked, memorySyncDir, syncBotMemory, type MemorySyncLedger } from "./memory-sync.ts";
import { validatePickBinding } from "./pick-sources.ts";
import { applyPicks, type PickEntry } from "./picks.ts";
import { Store } from "./store.ts";
import { memoryHealth, readMemoryFile, workspaceDir, writeMemoryFile } from "./workspace.ts";

it("keeps a hand save made after the peer chatted before its snapshot arrived", async () => {
  const botId = "bot-a";
  const syncId = "shared-bot";
  const folder = join(DATA_DIR, "drive");
  const peerFolder = join(DATA_DIR, "peer-drive");
  const peerId = "bot-b";
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture", mode: "automatic" }));
  store.createBot({ name: "Ada" }, { id: botId, seedMessages: false });
  const local: MemorySyncLedger = { bots: {} };
  const peer: MemorySyncLedger = { bots: {} };
  const sync = () => syncBotMemory(folder, syncId, workspaceDir(botId), local, { host: "local" });
  const syncPeer = () => syncBotMemory(peerFolder, syncId, workspaceDir(peerId), peer, { host: "peer" });
  const deliver = (from: string, to: string, device: string) => {
    const name = `${device}.json`;
    mkdirSync(memorySyncDir(to, syncId), { recursive: true });
    copyFileSync(join(memorySyncDir(from, syncId), name), join(memorySyncDir(to, syncId), name));
  };
  mkdirSync(folder);
  mkdirSync(peerFolder);
  writeMemoryFile(botId, "- Shared notes\n");
  sync();
  deliver(folder, peerFolder, local.device!);
  syncPeer();

  const now = Date.now();
  markTalked(peer, syncId, now - 1000);
  writeMemoryFile(peerId, "- Peer chat notes\n");
  syncPeer();

  const noteTalked = (id: string) => { if (id === botId) markTalked(local, syncId, now); };
  const deps: Partial<Parameters<typeof createBotRoutes>[0]> = {
    store,
    memoryHealthCheck: createMemoryHealthCheck({ health: memoryHealth, dropped: () => undefined }),
  };
  // SAFETY: putMemory uses only the store, health check and activity callback.
  const routes = createBotRoutes(Object.assign(deps, { noteTalked }) as Parameters<typeof createBotRoutes>[0]);
  const text = "- My hand edit\n";
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from(JSON.stringify({ text, baseRevision: readMemoryFile(botId).revision })));
  req.push(null);
  const res = new ServerResponse(req);
  const writeHead = vi.spyOn(res, "writeHead");
  await routes.putMemory(req, res, ["", botId]);
  expect(writeHead).toHaveBeenCalledWith(200, expect.anything());
  deliver(peerFolder, folder, peer.device!);
  expect(sync()["MEMORY.md"]).toBe("conflict");
  expect(readMemoryFile(botId).text).toBe(text);
});

it("shows an old pick only the screenshots on the message holding its quote, and never rewrites the file", async () => {
  const botId = "bot-shots";
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture", mode: "automatic" }));
  store.createBot({ name: "Shots" }, { id: botId, seedMessages: false });
  const thread = store.bot(botId)!.threadId;
  store.appendMessage(thread, { role: "user", kind: "text", at: MINUTE, text: 'the Reddit cards on the settings page look off\n\n<attached-image path="/shots/settings.png"/>' });
  const pick = store.appendMessage(thread, { role: "user", kind: "text", at: MINUTE + 1, text: 'Reddit cards\n\n<attached-image path="/shots/forum.png"/>' });
  const both = store.appendMessage(thread, { role: "user", kind: "text", at: MINUTE + 2, text: 'also clicking the icon again closes it\n\n<attached-image path="/shots/one.png"/>\n\n<attached-image path="/shots/two.png"/>' });
  const text = [
    "# Decision timeline", "",
    "## 2026-11-17 10:00 | Forum look | current", "- Picked: C - Reddit cards", '- Said: "Reddit cards"', "- Files: /shots/settings.png; /shots/forum.png", `- At: ${pick.at}`, "",
    "## 2026-11-17 10:01 | Forum icon click | current", "- Picked: Clicking again closes it", '- Said: "clicking the icon again closes it"', "- Files: /shots/one.png; /shots/two.png", `- At: ${both.at}`, "",
  ].join("\n");
  const file = join(workspaceDir(botId), "memory", "decisions.md");
  mkdirSync(join(workspaceDir(botId), "memory"), { recursive: true });
  writeFileSync(file, text);
  // SAFETY: memoryTopic uses only the store.
  const routes = createBotRoutes({ store } as Parameters<typeof createBotRoutes>[0]);
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const end = vi.spyOn(res, "end");
  await routes.memoryTopic(res, ["", botId, "decisions.md"]);
  // SAFETY: the route answers decisions.md with its text and parsed entries.
  const body = JSON.parse(String(end.mock.calls[0]![0])) as { text: string; entries: { files: string[] }[] };
  expect(body.entries.map((entry) => entry.files)).toEqual([["/shots/forum.png"], ["/shots/one.png", "/shots/two.png"]]);
  expect(body.text).toBe(text);
  expect(readFileSync(file, "utf8")).toBe(text);
});

const MINUTE = new Date(2026, 10, 17, 10).getTime();

function timelineRoute(id: string) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture", mode: "automatic" }));
  const { threadId } = store.createBot({ name: id }, { id, seedMessages: false });
  const memory = join(workspaceDir(id), "memory");
  const file = join(memory, "decisions.md");
  mkdirSync(memory, { recursive: true });
  // SAFETY: memoryTopic uses only the store.
  const routes = createBotRoutes({ store } as Parameters<typeof createBotRoutes>[0]);
  const read = async () => {
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    const end = vi.spyOn(res, "end");
    const start = performance.now();
    await routes.memoryTopic(res, ["", id, "decisions.md"]);
    const ms = performance.now() - start;
    // SAFETY: Success cases read the parsed entries from the decisions route.
    return { status: res.statusCode, body: JSON.parse(String(end.mock.calls[0]![0])) as { text: string; entries: PickEntry[] }, ms };
  };
  const say = (thread: string, at: number, file: string, actedAt?: number) => store.appendMessage(thread, {
    role: "user", kind: "text", at, actedAt, text: `I choose B\n\n<attached-image path="${file}"/>`,
  });
  const save = (...picks: Parameters<typeof applyPicks>[1]) => writeFileSync(file, applyPicks("", picks)!.text);
  return { store, threadId, file, read, say, save };
}

const boundPick = (thread: string, answer: { id: string; at: number }, key: string, file: string) => ({
  kind: "pick" as const, thread, messageId: answer.id, questionId: answer.id, at: answer.at, key, picked: "B", said: "I choose B", files: [file],
});

it("hides ambiguous legacy pictures at the same exact timestamp without rewriting the timeline", async () => {
  const { file, threadId, say, read } = timelineRoute("bot-legacy-same-minute");
  say(threadId, MINUTE, "/shots/first.png");
  say(threadId, MINUTE, "/shots/second.png");
  const text = ["# Decision timeline", "", ...["", " (2)"].flatMap((suffix, i) => [
    `## 2026-11-17 10:00${suffix} | Menu ${i} | current`, "- Picked: B", '- Said: "I choose B"', "- Picture: /shots/winner.png", "- Over pictures: /shots/loser.png", "- Files: /shots/first.png; /shots/second.png", "",
  ])].join("\n");
  writeFileSync(file, text);
  const before = statSync(file).mtimeMs;
  const { body } = await read();
  expect(body.entries.map(({ picture, overPictures, files }) => [picture, overPictures, files])).toEqual([[undefined, [], []], [undefined, [], []]]);
  expect(body.text).toBe(text);
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(before);
});

it("drops legacy option pictures whose captions disagree with an exact-time pick", async () => {
  const { file, threadId, say, read } = timelineRoute("bot-legacy-option-mismatch");
  const answer = say(threadId, MINUTE, "/shots/settings.png");
  writeFileSync(file, [
    "# Decision timeline", "", "## 2026-11-17 10:00 | Settings | current", "- Picked: B - green cards", '- Said: "I choose B"',
    "- Picture: /shots/forum.png (B - blue cards)", "- Over: A - gray cards", "- Over pictures: /shots/forum-a.png (A - red cards)",
    "- Files: /shots/settings.png", `- At: ${answer.at}`, "",
  ].join("\n"));
  const [pick] = (await read()).body.entries;
  expect(pick).toMatchObject({ picked: "B - green cards", overPictures: [], files: ["/shots/settings.png"] });
  expect(pick?.picture).toBeUndefined();
});

it("does not borrow either attachment for two old minute-only records", async () => {
  const { file, threadId, say, read } = timelineRoute("bot-legacy-minute-only");
  say(threadId, MINUTE, "/shots/first.png");
  say(threadId, MINUTE + 15_000, "/shots/second.png");
  writeFileSync(file, ["# Decision timeline", "", ...["", " (2)"].flatMap((suffix, i) => [
    `## 2026-11-17 10:00${suffix} | Menu ${i} | current`, "- Picked: B", '- Said: "I choose B"', "- Files: /shots/first.png; /shots/second.png", "",
  ])].join("\n"));
  expect((await read()).body.entries.map(({ files }) => files)).toEqual([[], []]);
});

it("holds files and time on previously saved picks that claim the same answer", async () => {
  const { file, threadId, say, save, read } = timelineRoute("bot-old-shared-answer");
  const answer = say(threadId, MINUTE, "/shots/settings.png");
  save(...["Forum", "Settings"].map((key) => boundPick(threadId, answer, key, "/shots/settings.png")));
  const saved = readFileSync(file, "utf8");
  const { body } = await read();
  expect(body.entries.map(({ key, picked, binding, files, at }) => [key, picked, binding, files, at])).toEqual([
    ["Forum", "B", "unbound", [], undefined], ["Settings", "B", "unbound", [], undefined],
  ]);
  expect(body.text).toBe(saved);
  expect(readFileSync(file, "utf8")).toBe(saved);
});

it("resolves an untagged legacy thumbnail to its room's thread from direct chat", async () => {
  const id = "bot-legacy-room";
  const { store, file, say, read } = timelineRoute(id);
  const room = store.createGroup("Review room", [id]);
  const path = "C:\\room\\legacy.png";
  const answer = say(room.threadId, MINUTE + 10, path);
  writeFileSync(file, `# Decision timeline\n\n## 2026-11-17 10:00 | Menu | current\n- Picked: B\n- Said: "I choose B"\n- Files: ${path}\n- At: ${answer.at}\n`);
  expect((await read()).body.entries[0]).toMatchObject({ thread: room.threadId, files: [path] });
});

it("returns 404 for a decisions.md read error and 200 for a fresh bot", async () => {
  const { file, read } = timelineRoute("bot-read-error");
  expect(await read()).toMatchObject({ status: 200, body: { text: "", entries: [] } });
  mkdirSync(file);
  expect((await read()).status).toBe(404);
});

it("keeps the bound screenshot and At when the answer lands on the exact minute", async () => {
  const { threadId, say, save, read } = timelineRoute("bot-exact-minute");
  const first = say(threadId, MINUTE, "/shots/forum.png");
  const second = say(threadId, MINUTE + 15_000, "/shots/settings.png");
  save(boundPick(threadId, first, "Forum", "/shots/forum.png"), boundPick(threadId, second, "Settings", "/shots/settings.png"));
  expect((await read()).body.entries).toMatchObject([
    { at: MINUTE, files: ["/shots/forum.png"] }, { at: MINUTE + 15_000, files: ["/shots/settings.png"] },
  ]);
});

it("keeps the pick attached to its original task when the user switches tasks", async () => {
  const id = "bot-cross-task";
  const { store, file, threadId, say, save, read } = timelineRoute(id);
  const answer = say(threadId, MINUTE + 1, "/shots/first.png");
  save({ ...boundPick(threadId, answer, "Forum", "/shots/first.png"), thread: undefined, messageId: undefined, questionId: undefined });
  const saved = readFileSync(file, "utf8");
  const files = async () => (await read()).body.entries[0]?.files;
  expect(await files()).toEqual(["/shots/first.png"]);
  const next = store.createTask(id)!;
  say(next.threadId, MINUTE + 2, "/shots/second.png");
  expect(await files()).toEqual(["/shots/first.png"]);
  store.switchTask(id, threadId);
  expect(await files()).toEqual(["/shots/first.png"]);
  expect(readFileSync(file, "utf8")).toBe(saved);
});

it("keeps the saved picture when an older action is delivered later", async () => {
  const { threadId, say, save, read } = timelineRoute("bot-late-delivery");
  const first = say(threadId, MINUTE + 1_000, "/shots/first.png");
  save(boundPick(threadId, first, "Forum", "/shots/first.png"));
  say(threadId, MINUTE + 1_400, "/shots/late.png", MINUTE + 800);
  expect((await read()).body.entries[0]?.files).toEqual(["/shots/first.png"]);
});

it("reads 100 bound picks without reading their 2,000-message transcript", async () => {
  const { store, threadId, save, read } = timelineRoute("bot-read-cost");
  let textReads = 0;
  const rows = Array.from({ length: 2_000 }, (_, i) => ({ id: `m${i}`, role: "user" as const, kind: "text" as const, at: MINUTE + i, get text() {
    textReads++;
    return 'I choose B\n\n<attached-image path="/shots/menu.png"/>';
  } }));
  const transcript = vi.spyOn(store, "messagesFor").mockReturnValue(rows);
  save(...rows.slice(0, 100).map((row, i) => {
    const pick = boundPick(threadId, row, `Menu ${i}`, "/shots/menu.png");
    const binding = validatePickBinding({ ...pick, over: [] }, { id: row.id, thread: threadId, at: row.at, files: pick.files });
    expect(binding).toBeDefined();
    return { ...pick, binding };
  }));
  const samples = [await read(), await read(), await read()];
  console.info(`Timeline 2,000 messages, 100 picks: ${samples.map(({ ms }) => ms.toFixed(1)).join(" / ")} ms (${textReads} text reads)`);
  expect(samples.every(({ body }) => body.entries.length === 100)).toBe(true);
  expect(textReads).toBe(0);
  expect(transcript).not.toHaveBeenCalled();
});
