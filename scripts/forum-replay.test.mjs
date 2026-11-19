import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./forum-replay.ts", import.meta.url));
const AT = 1_700_000_000_000;
const MINUTE = 60_000;

const root = mkdtempSync(join(tmpdir(), "orbit-forum-replay-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function replay(holds, cards) {
  const copy = join(root, "orbit");
  const home = join(root, "home");
  mkdirSync(join(copy, "board"), { recursive: true });
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(join(copy, "bots.json"), "[]");
  const db = new DatabaseSync(join(copy, "messages.db"));
  db.exec("CREATE TABLE messages (thread_id TEXT, at INTEGER, kind TEXT, json TEXT)");
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?, 'options', ?)");
  for (const [threadId, at] of cards) insert.run(threadId, at, JSON.stringify({ card: { askUser: true, subtitle: "Which port?", options: [] } }));
  db.close();
  writeFileSync(join(copy, "forum-holds.ndjson"), holds.map(([threadId, at]) => `${JSON.stringify({ at, kind: "ask", botId: "ada", threadId, postIds: ["p1"] })}\n`).join(""));
  const run = spawnSync(process.execPath, [SCRIPT, copy, "--end", new Date(AT + 60 * MINUTE).toISOString()], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

describe("forum replay", () => {
  it("counts a held ask with no later card on its thread as a false hold, never a deflection", () => {
    const out = replay(
      [["ta", AT], ["tb", AT], ["tc", AT]],
      [["ta", AT + MINUTE], ["tb", AT - MINUTE], ["tc", AT - MINUTE], ["ta", AT + 2 * MINUTE]],
    );
    expect(out).toMatchObject({ holdsShown: 3, reasked: 1, falseHold: "2 (67%)" });
    expect(out).not.toHaveProperty("deflected");
  });
});
