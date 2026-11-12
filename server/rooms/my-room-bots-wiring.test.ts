import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

it("keeps a joined room's task out of chat sync", () => {
  expect(between("function threadSyncTarget(", "\n}\n")).toContain("myRoomBotThreads().has(threadId)");
  expect(between("function sideThreadIds(", "\n}\n")).toContain("...myRoomBotThreads()");
  expect(between("createThreadSyncV2Store({", "maintenance:")).toMatch(/target: \(threadId\) => \{[^}]*sideThreadIds\(\)\.has\(threadId\)\) return null;/);
});

it("never follows a joined room's task as the user chat", () => {
  const follows = source.match(/followNewestTask\([^\n;]*?\);/g) ?? [];
  expect(follows.length).toBeGreaterThanOrEqual(4);
  for (const call of follows) expect(call).toMatch(/, side(ThreadIds\(\)|Threads)\);$/);
});

it("lets the memory pass save from a joined room's task like any other task", () => {
  const settled = between("summaryBuild.onSettled(bot.id, event.threadId);", "memoryPass.onSettled(");
  const guard = source.slice(source.lastIndexOf("if (", source.indexOf(settled)), source.indexOf(settled));
  expect(guard).toBe("if (!store.groupByThread(event.threadId)) {\n            ");
  expect(source).not.toMatch(/memoryPass[^\n]*myRoomBot/);
});

it("routes a sent line to this PC's bots off the send path", () => {
  expect(source).toContain("onSent: (roomId, entry) => setImmediate(() => myRoomBotTurns.sent(roomId, entry)),");
});
