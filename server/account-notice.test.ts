import { describe, expect, it, vi } from "vitest";

import type { MainChange } from "./account-lifecycle.ts";
import { createAccountNotices } from "./account-notice.ts";
import type { WorkerRun, WorkerRuns } from "./worker-panes.ts";

type Engine = "claude" | "codex";
const LABELS = { claude: "Claude", codex: "Codex" };
const ID = { c1: "claude", c2: "acct-canary-c2", c3: "acct-canary-c3", x1: "codex", x2: "acct-canary-x2" };

function fixture(runs: WorkerRun[] = []) {
  const accounts = new Map<string, { engine: Engine; number: number; nickname: string | null }>([
    [ID.c1, { engine: "claude", number: 1, nickname: null }], [ID.c2, { engine: "claude", number: 2, nickname: null }],
    [ID.c3, { engine: "claude", number: 3, nickname: null }], [ID.x1, { engine: "codex", number: 1, nickname: null }],
    [ID.x2, { engine: "codex", number: 2, nickname: null }],
  ]);
  const names = {
    get: (id: string) => {
      const row = accounts.get(id);
      return row ? { id, ...row, name: row.nickname ?? `${LABELS[row.engine]} ${row.number}` } : null;
    },
    nameOf: (id: string, engine: string) => names.get(id)?.name ?? `${LABELS[engine as Engine]} (removed)`,
  };
  let host: () => Promise<WorkerRuns> = async () => ({ known: true, runs });
  const runsCall = vi.fn((_timeoutMs: number) => host());
  const notices = createAccountNotices({ names, sync: vi.fn(), runs: runsCall, schedule: queueMicrotask });
  let seq = 0;
  const change = (engine: Engine, from: string, to: string) => notices.mainChanged({ base: engine, engine, from: { id: from, generation: 1 }, to: { id: to, generation: 1 }, seq: ++seq } satisfies MainChange);
  return { notices, accounts, change, runsCall, setHost: (next: () => Promise<WorkerRuns>) => { host = next; }, setRuns: (next: WorkerRun[]) => { runs = next; } };
}

function run(botId: string, label: string | null, accountId: string, engine: Engine = "claude"): WorkerRun {
  return { botId, paneId: `pane-${label ?? Math.random()}`, label, engine, accountId, accountGeneration: 1, state: "busy" };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("account notices", () => {
  it("adds one Account note on the next turn after Main changes for a bot with workers on that engine", async () => {
    const f = fixture([run("atlas", "ATLAS-2", ID.c1), run("atlas", "ATLAS-1", ID.c1), run("atlas", null, ID.c1), run("atlas", null, ID.c1), run("atlas", "ATLAS-3", ID.c2)]);
    f.change("claude", ID.c1, ID.c2);
    await settle();
    expect(f.notices.forTurn("atlas").text).toBe("Account note: Claude Main is now Claude 2 (was Claude 1). Replies already resolved keep their account. Still on Claude 1: ATLAS-1, ATLAS-2, +2.");
    expect(f.runsCall).toHaveBeenCalledOnce();
    expect(f.runsCall).toHaveBeenCalledWith(300);
  });

  it("adds no note on the turn after it was delivered", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.c1)]);
    f.change("claude", ID.c1, ID.c2);
    await settle();
    const turn = f.notices.forTurn("atlas");
    expect(turn.text).toMatch(/^Account note: /);
    turn.commit();
    turn.commit();
    expect(f.notices.forTurn("atlas").text).toBeNull();
  });

  it("adds no note for a bot with no workers on that engine", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.x1, "codex"), run("mira", "MIRA-1", ID.c1)]);
    f.change("claude", ID.c1, ID.c2);
    await settle();
    expect(f.notices.forTurn("atlas").text).toBeNull();
    expect(f.notices.forTurn("orion").text).toBeNull();
    expect(f.notices.forTurn("mira").text).toMatch(/^Account note: /);
  });

  it("adds no note when Main changes and changes back between turns", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.c1)]);
    f.change("claude", ID.c1, ID.c2);
    f.change("claude", ID.c2, ID.c1);
    await settle();
    expect(f.notices.forTurn("atlas").text).toBeNull();
    f.change("claude", ID.c1, ID.c2);
    f.change("claude", ID.c2, ID.c3);
    await settle();
    expect(f.notices.forTurn("atlas").text).toBe("Account note: Claude Main is now Claude 3 (was Claude 1). Replies already resolved keep their account. Still on Claude 1: ATLAS-1.");
  });

  it("puts Claude and Codex in one Account note and ends it when every worker is on the new Main", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.x2, "codex"), run("atlas", "ATLAS-2", ID.c2)]);
    f.change("codex", ID.x1, ID.x2);
    f.change("claude", ID.c1, ID.c2);
    await settle();
    expect(f.notices.forTurn("atlas").text).toBe("Account note: Claude Main is now Claude 2 (was Claude 1). Codex Main is now Codex 2 (was Codex 1). Replies already resolved keep their account.");
    expect(f.runsCall).toHaveBeenCalledOnce();
  });

  it("lists at most 3 labels then +N, grouped by account", async () => {
    const f = fixture([run("atlas", "MIRA-10", ID.c3), run("atlas", "MIRA-2", ID.c3), run("atlas", "ATLAS-2", ID.c1), run("atlas", "MIRA-1", ID.c3), run("atlas", "ATLAS-1", ID.c1)]);
    f.change("claude", ID.c1, ID.c2);
    await settle();
    expect(f.notices.forTurn("atlas").text).toBe("Account note: Claude Main is now Claude 2 (was Claude 1). Replies already resolved keep their account. Still on Claude 1: ATLAS-1, ATLAS-2; Claude 3: MIRA-1, +2.");
  });

  it("defers a notice without delaying send when the host is unavailable", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.c1)]);
    f.setHost(() => new Promise(() => {}));
    f.change("claude", ID.c1, ID.c2);
    const turn = f.notices.forTurn("atlas");
    expect(turn).not.toBeInstanceOf(Promise);
    expect(turn.text).toBeNull();
    turn.commit();

    const g = fixture([run("atlas", "ATLAS-1", ID.c1)]);
    g.setHost(async () => ({ known: false, reason: "old-host" }));
    g.change("claude", ID.c1, ID.c2);
    await settle();
    expect(g.notices.forTurn("atlas").text).toBeNull();
    await settle();
    expect(g.runsCall).toHaveBeenCalledOnce();
    g.setHost(async () => ({ known: true, runs: [run("atlas", "ATLAS-1", ID.c1)] }));
    g.change("claude", ID.c2, ID.c3);
    await settle();
    expect(g.notices.forTurn("atlas").text).toBe("Account note: Claude Main is now Claude 3 (was Claude 1). Replies already resolved keep their account. Still on Claude 1: ATLAS-1.");
  });

  it("preserves a newer Main change while committing an older notice", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.c1)]);
    f.change("claude", ID.c1, ID.c2);
    await settle();
    const turn = f.notices.forTurn("atlas");
    expect(turn.text).toContain("Claude Main is now Claude 2 (was Claude 1).");
    f.change("claude", ID.c2, ID.c3);
    await settle();
    turn.commit();
    expect(f.notices.forTurn("atlas").text).toBe("Account note: Claude Main is now Claude 3 (was Claude 2). Replies already resolved keep their account. Still on Claude 1: ATLAS-1.");
  });

  it("keeps the note pending when the turn fails or is cancelled before acceptance", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.c1)]);
    f.change("claude", ID.c1, ID.c2);
    await settle();
    const failed = f.notices.forTurn("atlas").text;
    expect(failed).toMatch(/^Account note: /);
    expect(f.notices.forTurn("atlas").text).toBe(failed);
    f.notices.forget("atlas");
    expect(f.notices.forTurn("atlas").text).toBe(failed);
  });

  it("names the old Main after it was removed", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.c2)]);
    f.accounts.get(ID.c2)!.nickname = "Night";
    f.change("claude", ID.c2, ID.c3);
    f.accounts.delete(ID.c2);
    await settle();
    expect(f.notices.forTurn("atlas").text).toBe("Account note: Claude Main is now Claude 3 (was Night). Replies already resolved keep their account. Still on Claude (removed): ATLAS-1.");
  });

  it("keeps account identities out of all generated output", async () => {
    const f = fixture([run("atlas", "ATLAS-1", ID.c2), run("atlas", null, ID.x2, "codex"), run("atlas", "ATLAS-2", ID.c3)]);
    const texts: string[] = [];
    for (const [engine, from, to] of [["claude", ID.c2, ID.c3], ["codex", ID.x2, ID.x1], ["claude", ID.c3, ID.c2]] as const) {
      f.change(engine, from, to);
      await settle();
      const turn = f.notices.forTurn("atlas");
      if (turn.text) texts.push(turn.text);
      turn.commit();
    }
    expect(texts).toHaveLength(3);
    for (const text of texts) expect(text).not.toMatch(/canary|@|generation|pane-/i);
  });
});
