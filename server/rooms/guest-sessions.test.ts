import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { GuestSessions } from "./guest-sessions.ts";

it("starts a guest's turn over unless guests' turns alone built the session", () => {
  const sessions = new GuestSessions();
  // after a restart nothing is known, so the first guest turn starts over
  expect(sessions.guestTurn("t")).toBe(true);
  expect(sessions.guestTurn("t")).toBe(false);
  sessions.ownerTurn("t");
  expect(sessions.guestTurn("t")).toBe(true);
  expect(sessions.guestTurn("other")).toBe(true);
});

it("recycles the session in startClaimedTurn for a joined room guest's read-only turn, background work or not", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.slice(source.indexOf("async function startClaimedTurn("));
  const block = start.slice(start.indexOf("const recycleWanted = "), start.indexOf("const recycleReason = "));
  expect(block).toContain("const guestRecycle = (opts?.readOnly === true ? guestSessions.guestTurn(threadId) : (guestSessions.ownerTurn(threadId), false))");
  expect(block).toContain("&& !rewound && !fresh && task.resumeCursors[instanceId] !== undefined;");
  expect(block).toContain("let recycleDeferred = recycleWanted && !fresh && !guestRecycle && ");
  expect(block).toContain("const recycled = (recycleWanted && !recycleDeferred) || guestRecycle;");
});
