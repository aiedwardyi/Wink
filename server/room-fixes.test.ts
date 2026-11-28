import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { createRoomFixes, type RoomFixDeps } from "./room-fixes.ts";
import { closeRoomsDb, createRoom, recentRoomEntries } from "./rooms/db.ts";
import { Store, type BotRecord, type GroupRecord } from "./store.ts";
import { removeTestData } from "./testing/test-home.ts";

const SESSION = "abcdef12-3456-7890-abcd-ef1234567890";
const MERGE = "a".repeat(40);
const WINK_REMOTES = "origin\thttps://github.com/aiedwardyi/Wink.git (fetch)\norigin\thttps://github.com/aiedwardyi/Wink.git (push)\n";

let store: Store;
let bot: BotRecord;
let room: GroupRecord & { hosted: { roomId: string } };
let gh: ReturnType<typeof vi.fn<RoomFixDeps["gh"]>>;
let linkedAt: number;

const fixes = (git: RoomFixDeps["git"] = async () => WINK_REMOTES) => createRoomFixes({
  dataDir: DATA_DIR,
  store,
  pane: async (_botId, sessionId) => (SESSION.startsWith(sessionId) ? { sessionId: SESSION, cwd: "D:/repo/wt/fix-export" } : null),
  git,
  gh,
  now: () => linkedAt,
});

const roomLines = () => store.messagesFor(room.threadId).filter((message) => message.from?.botId === bot.id).map((message) => message.text);
const committed = () => recentRoomEntries(room.hosted.roomId, 20).map((entry) => entry.text);
const reportDone = () => store.appendMessage(bot.threadId, {
  role: "bot",
  kind: "note",
  text: `[pane abcdef12] [FIX-EXPORT] from ${bot.name} (${bot.id}): DONE FIX-EXPORT branch=fix/export sha=${"b".repeat(40)} dirty=0\nPR 12 merged.`,
});

beforeEach(() => {
  closeRoomsDb();
  removeTestData(DATA_DIR);
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  bot = store.patchBot(store.createBot().id, { name: "Wink" })!;
  // SAFETY: created with hosted set, so hosted.roomId is present.
  room = store.createGroup("Team", [bot.id], false, undefined, undefined, { roomId: createRoom("Team").id }) as typeof room;
  linkedAt = Date.parse("2026-11-16T05:00:00Z");
  gh = vi.fn<RoomFixDeps["gh"]>(async (_cwd, args) => {
    if (args[0] === "pr") return JSON.stringify([{ mergedAt: "2026-11-16T07:00:00Z", mergeCommit: { oid: MERGE } }]);
    if (args[1] === `repos/aiedwardyi/wink/compare/${MERGE}...v1.0.273`) return "ahead\n";
    if (args[1] === `repos/aiedwardyi/wink/compare/${MERGE}...v1.0.272`) return "diverged\n";
    throw new Error("HTTP 404: Not Found");
  });
});
afterEach(closeRoomsDb);

describe("post_to_group", () => {
  it("links exactly one hosted room entry to the bot's message", () => {
    const text = "Research links\n- One\n- Two";
    expect(fixes().postToGroup(bot.id, { group: "team", text })).toEqual({ text: 'Posted in "Team".' });
    const entries = recentRoomEntries(room.hosted.roomId, 20);
    expect(entries).toEqual([expect.objectContaining({ text, author: { kind: "bot", id: bot.id, name: bot.name } })]);
    expect(store.messagesFor(room.threadId)).toEqual([expect.objectContaining({
      text, role: "bot", kind: "text", from: { botId: bot.id, name: bot.name, color: bot.color }, roomEntryId: entries[0]!.id,
    })]);
    expect(store.group(room.id)?.unread).toBe(true);
  });
});

describe("room fixes", () => {
  it("stores the link when a bot links the pane it just launched", async () => {
    const linked = await fixes().link({ botId: bot.id, threadId: room.threadId, sessionId: "abcdef12", title: "Export button does nothing" });
    expect(linked).toEqual({ text: expect.stringContaining('"Team"') });
    expect(JSON.parse(readFileSync(join(DATA_DIR, "room-fixes.json"), "utf8"))).toEqual([
      { botId: bot.id, groupId: room.id, sessionId: SESSION, title: "Export button does nothing", lang: "en", at: linkedAt, repo: "aiedwardyi/wink" },
    ]);
  });

  it("posts Fix started once as the bot, across a repeat call and a restart", async () => {
    const input = { botId: bot.id, threadId: room.threadId, sessionId: SESSION, title: "Export button does nothing" };
    await fixes().link({ ...input, threadId: bot.threadId, room: "team" });
    await fixes().link(input);
    await fixes().link(input);
    expect(roomLines()).toEqual(["Fix started: Export button does nothing"]);
    expect(committed()).toEqual(["Fix started: Export button does nothing"]);
  });

  it("posts Fixed in once, only for an offered release that holds the merged work", async () => {
    await fixes().link({ botId: bot.id, threadId: room.threadId, sessionId: SESSION, title: "Export button does nothing" });
    reportDone();
    const live = fixes();
    await live.released("1.0.272");
    expect(roomLines()).toEqual(["Fix started: Export button does nothing"]);
    await live.released("1.0.273");
    await live.released("1.0.273");
    await fixes().released("1.0.273");
    await fixes().released("1.0.274");
    expect(roomLines()).toEqual(["Fix started: Export button does nothing", "Fixed in 1.0.273: Export button does nothing"]);
    expect(committed()).toEqual(["Fix started: Export button does nothing", "Fixed in 1.0.273: Export button does nothing"]);
    expect(gh).toHaveBeenCalledWith(expect.any(String), ["pr", "list", "--repo=aiedwardyi/wink", "--head=fix/export", "--state=merged", "--json=mergedAt,mergeCommit", "--limit=10"]);
  });

  it("finds the DONE report after the user moves to another task", async () => {
    await fixes().link({ botId: bot.id, threadId: room.threadId, sessionId: SESSION, title: "Export button does nothing" });
    reportDone();
    store.createTask(bot.id);
    await fixes().released("1.0.273");
    expect(roomLines()).toEqual(["Fix started: Export button does nothing", "Fixed in 1.0.273: Export button does nothing"]);
  });

  it("says no release line follows for a pane outside a checkout of Wink's repo", async () => {
    const input = { botId: bot.id, threadId: room.threadId, sessionId: SESSION, title: "Export button does nothing" };
    expect(await fixes(async () => "origin\thttps://github.com/acme/app.git (fetch)\n").link(input)).toEqual({ text: expect.stringContaining("no release line will follow") });
    store.createGroup("Ops", [bot.id], false);
    expect(await fixes(async () => { throw new Error("fatal: not a git repository"); }).link({ ...input, room: "ops" })).toEqual({ text: expect.stringContaining("no release line will follow") });
    reportDone();
    await fixes().released("1.0.273");
    expect(roomLines()).toEqual(["Fix started: Export button does nothing"]);
    expect(gh).not.toHaveBeenCalled();
  });

  it("keeps links still waiting for a release when the file is full", async () => {
    const waiting = { botId: bot.id, groupId: room.id, sessionId: "waiting", title: "Old fix", lang: "en", at: 1, repo: "aiedwardyi/wink" };
    const shipped = Array.from({ length: 200 }, (_, index) => ({ ...waiting, sessionId: `shipped-${index}`, at: 2 + index, fixedIn: "1.0.1" }));
    writeFileSync(join(DATA_DIR, "room-fixes.json"), JSON.stringify([waiting, ...shipped]));
    await fixes().link({ botId: bot.id, threadId: room.threadId, sessionId: SESSION, title: "Export button does nothing" });
    const saved: Array<{ sessionId: string }> = JSON.parse(readFileSync(join(DATA_DIR, "room-fixes.json"), "utf8"));
    expect(saved).toHaveLength(200);
    expect(saved.map((fix) => fix.sessionId)).toEqual(expect.arrayContaining(["waiting", SESSION]));
  });

  it("never posts Fixed in on a merge alone", async () => {
    const live = fixes();
    await live.link({ botId: bot.id, threadId: room.threadId, sessionId: SESSION, title: "Export button does nothing" });
    await live.released("1.0.273");
    expect(gh).not.toHaveBeenCalled();
    reportDone();
    await live.released("1.0.272");
    await live.released("1.0.300");
    await live.released("main");
    expect(roomLines()).toEqual(["Fix started: Export button does nothing"]);
  });

  it("skips a PR with that branch merged before the link", async () => {
    linkedAt = Date.parse("2026-11-16T08:00:00Z");
    await fixes().link({ botId: bot.id, threadId: room.threadId, sessionId: SESSION, title: "Export button does nothing" });
    reportDone();
    await fixes().released("1.0.273");
    expect(roomLines()).toEqual(["Fix started: Export button does nothing"]);
  });

  it("posts both lines in Korean when the bot titles the fix in Korean", async () => {
    await fixes().link({ botId: bot.id, threadId: room.threadId, sessionId: SESSION, title: "내보내기 버튼이 안 눌려요" });
    reportDone();
    await fixes().released("1.0.273");
    expect(committed()).toEqual(["수정 시작: 내보내기 버튼이 안 눌려요", "1.0.273에서 수정됨: 내보내기 버튼이 안 눌려요"]);
  });

  it("posts nothing for work that did not come from a room", async () => {
    const local = fixes();
    expect(await local.link({ botId: bot.id, threadId: bot.threadId, sessionId: SESSION, title: "Refactor the parser" })).toEqual({ error: expect.stringContaining("not in a room") });
    expect(await local.link({ botId: bot.id, threadId: bot.threadId, sessionId: SESSION, title: "Refactor the parser", room: "Design" })).toEqual({ error: expect.stringContaining("Your rooms: Team") });
    expect(await local.link({ botId: bot.id, threadId: room.threadId, sessionId: "ffffffff", title: "Refactor the parser" })).toEqual({ error: expect.stringContaining("Unknown pane") });
    reportDone();
    await local.released("1.0.273");
    expect(roomLines()).toEqual([]);
    expect(committed()).toEqual([]);
    expect(gh).not.toHaveBeenCalled();
  });
});
