import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { GuestSessions } from "./guest-sessions.ts";

it("starts a guest's turn over unless guests' turns alone built the session", () => {
  const sessions = new GuestSessions();
  // after a restart nothing is known, so the first guest turn starts over
  expect(sessions.guestTurn("t", "i", "owner")).toBe(true);
  // a guest's setup failed before its session opened, so the cursor is still the owner's
  expect(sessions.guestTurn("t", "i", "owner")).toBe(true);
  expect(sessions.guestTurn("t", "i", "guest")).toBe(false);
  sessions.ownerTurn("t");
  expect(sessions.guestTurn("t", "i", "guest")).toBe(true);
  expect(sessions.guestTurn("other", "i", "guest")).toBe(true);
  // another engine's cursor is not one a guest's turn opened
  expect(sessions.guestTurn("t", "j", "owner-j")).toBe(true);
});

it("recycles the session in startClaimedTurn for a joined room guest's read-only turn, background work or not", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.slice(source.indexOf("async function startClaimedTurn("));
  const block = start.slice(start.indexOf("const recycleWanted = "), start.indexOf("const recycleReason = "));
  expect(block).toContain("const guestRecycle = (opts?.readOnly === true ? guestSessions.guestTurn(threadId, instanceId, task.resumeCursors[instanceId]) : (guestSessions.ownerTurn(threadId), false))");
  expect(block).toContain("&& !rewound && !fresh && task.resumeCursors[instanceId] !== undefined;");
  expect(block).toContain("let recycleDeferred = recycleWanted && !fresh && !guestRecycle && ");
  expect(block).toContain("const recycled = (recycleWanted && !recycleDeferred) || guestRecycle;");
  expect(block, "a guest's turn keeps the owner's cursor until its own session replaces it").toContain("if (!guestRecycle) store.clearResumeCursors(bot.id, threadId);");
});
