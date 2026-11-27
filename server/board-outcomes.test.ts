// A held call is SIM's prediction: the offered fix helped when the turn ends without calling, missed when the same blocker comes back.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createBoard } from "./board.ts";
import { createBoardCalls, type ForumHold } from "./board-calls.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const BLOCKER = { kind: "engine" as const, note: "pnpm install fails with EPERM on node_modules" };

const setup = () => {
  const board = createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-board-outcomes-")), "board"), pcId: () => "home" });
  const stuck = board.post({ author_bot_id: "scout", kind: "stuck", title: BLOCKER.note, body: BLOCKER.note, project_id: "wink", source_ref: "call:t0:0:engine:EPERM" });
  board.solve(stuck.id, "Close the dev server holding node_modules, then run pnpm install again.");
  const holds: ForumHold[] = [];
  const calls = createBoardCalls({ board, projectOf: () => "wink", room: () => false, held: (hold) => holds.push(hold) });
  return { board, calls, holds, id: stuck.id };
};

describe("held call outcomes", () => {
  it("a hold then an ok turn end logs helped", () => {
    const { calls, holds, id } = setup();
    expect(calls.hold("ada", "t1", [], [BLOCKER]).blockers).toEqual([]);
    calls.turnEnded("t1", true);
    expect(holds).toEqual([{ kind: "call", botId: "ada", threadId: "t1", postIds: [id] }, { kind: "helped", botId: "ada", threadId: "t1", postIds: [id] }]);
  });

  it("a hold then the same blocker again logs missed, and the turn end adds no helped", () => {
    const { board, calls, holds, id } = setup();
    calls.hold("ada", "t1", [], [BLOCKER]);
    expect(calls.hold("ada", "t1", [], [BLOCKER]).blockers).toEqual([BLOCKER]);
    calls.turnEnded("t1", true);
    expect(holds.map((hold) => [hold.kind, hold.postIds])).toEqual([["call", [id]], ["missed", [id]]]);
    expect(board.get(id)!.helped_bot_ids).toEqual([]);
  });

  it("a failed turn or a turn with no hold logs nothing", () => {
    const { calls, holds } = setup();
    calls.turnEnded("t1", true);
    calls.hold("ada", "t1", [], [BLOCKER]);
    calls.turnEnded("t1", false);
    expect(holds.map((hold) => hold.kind)).toEqual(["call"]);
  });
});
