import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AttributionSource } from "./auto-routing-attrib.ts";
import { AutoRoutingHabits } from "./auto-routing-habits.ts";
import { createAutoRoutingOperations, type AutoChangePayload } from "./auto-routing-operations.ts";
import { AutoRoutingRules } from "./auto-routing-rules.ts";
import { AutoRoutingState } from "./auto-routing.ts";
import { DATA_DIR } from "./config.ts";

function fixture() {
  const dir = join(DATA_DIR, randomUUID());
  const state = new AutoRoutingState(dir);
  const rules = new AutoRoutingRules(dir);
  const habits = new AutoRoutingHabits(dir);
  const live = { task: "task", text: "Use Sol max", enabled: true };
  const source = (_botId: string, threadId: string): AttributionSource => ({ botId: "bot", threadId, ownerId: "user", authorized: live.enabled,
    turn: { botId: "bot", threadId, turnId: "a".repeat(32), owner: "user", depth: 0, rootId: null, userKeys: ["typed"], nowWatch: [] },
    messages: [{ id: "typed", role: "user", kind: "text", text: live.text, at: 1 }] });
  const rows: AutoChangePayload[] = [];
  const emit = vi.fn((_bot: string, _thread: string, row: AutoChangePayload) => { rows.push(row); });
  const ops = createAutoRoutingOperations({ state, rules, habits, source, taskId: () => live.task, emit, now: () => 1000 });
  const tool = (input: Parameters<typeof ops.tool>[2], thread = "thread") => ops.tool("bot", thread, input);
  ops.setEnabled("bot", true);
  return { dir, state, rules, habits, ops, rows, live, tool };
}
const pick = { op: "pick", target: "worker", model: "gpt-6.1-sol", effort: "max", quote: "Sol max" };

describe("task-local Auto operations", () => {
  it("keeps a verified pick across turns and reload, with independent thread tasks", () => {
    const f = fixture();
    expect(f.tool(pick)).toEqual({ applied: true });
    expect(f.state.pick("bot", "thread", "task")).toEqual({ engine: "codex", model: "gpt-6.1-sol", effort: "max" });
    expect(new AutoRoutingState(f.dir).pick("bot", "thread", "task")).toEqual(f.state.pick("bot", "thread", "task"));
    f.live.text = "Use Opus";
    f.tool({ op: "pick", model: "claude-opus-5-5", quote: "Opus" }, "other");
    expect(f.state.pick("bot", "other", "task")).toEqual({ engine: "claudeAgent", model: "claude-opus-5-5" });
    expect(f.state.pick("bot", "thread", "task")?.model).toBe("gpt-6.1-sol");
    expect(f.state.pick("bot", "thread", "new-task")).toBeUndefined();
  });

  it("leaves old picks intact on hints, invalid schema, deferred chat and disabled Auto", () => {
    const f = fixture();
    f.tool(pick);
    const before = f.state.get("bot");
    for (const op of [{ ...pick, quote: "Opus" }, { ...pick, target: "chat" }, { ...pick, account: "untrusted" }, { ...pick, model: "unknown" }, { ...pick, op: "reset" }, { ...pick, op: "setPreference", max: true }]) {
      expect(f.tool(op)).toMatchObject({ applied: false });
      expect(f.state.get("bot")).toEqual(before);
    }
    f.ops.setEnabled("bot", false);
    expect(f.tool(pick)).toMatchObject({ applied: false });
    expect(f.rows).toHaveLength(1);
  });

  it("undoes only the newest pick to its captured prior pick, then to Auto", () => {
    const f = fixture();
    f.tool(pick);
    const first = f.rows[0].id;
    f.live.text = "Opus high";
    f.tool({ ...pick, model: "claude-opus-5-5", effort: "high", quote: "Opus high" });
    const second = f.rows[1].id;
    expect(() => f.ops.undo("bot", "thread", first)).toThrow("no longer");
    expect(f.ops.undo("bot", "thread", second)).toEqual({ applied: true });
    expect(f.state.pick("bot", "thread", "task")?.model).toBe("gpt-6.1-sol");
    expect(() => f.ops.undo("bot", "thread", second)).toThrow();
    expect(() => f.ops.undo("bot", "thread", first)).toThrow();
    const g = fixture();
    g.tool(pick);
    g.ops.undo("bot", "thread", g.rows[0].id);
    expect(g.state.pick("bot", "thread", "task")).toBeUndefined();
    expect(g.state.get("bot")?.pickVersion).toBe(2);
  });

  it("restores captured rules as a new version and prevents older pick undo", () => {
    const f = fixture();
    f.tool(pick);
    const pickId = f.rows[0].id;
    f.live.text = "Use Sonnet high for searches";
    const rule = { op: "setPreference", target: "worker", taskClass: "research", model: "claude-sonnet-5-5", effort: "high", quote: "Sonnet high" };
    expect(f.tool(rule)).toEqual({ applied: true });
    expect(f.rules.current().id).toBe(1);
    expect(() => f.ops.undo("bot", "thread", pickId)).toThrow();
    f.ops.undo("bot", "thread", f.rows.at(-1)!.id);
    expect(f.rules.current()).toEqual({ id: 2, content: { max: false, preferences: [] } });
    expect(new AutoRoutingRules(f.dir).current()).toEqual(f.rules.current());
  });

  it("accepts typed chat undo but never another task's or quoted undo", () => {
    const f = fixture();
    f.tool(pick);
    f.live.task = "other";
    expect(() => f.ops.undo("bot", "thread", f.rows[0].id)).toThrow();
    f.live.task = "task";
    f.live.text = '"undo"';
    expect(f.tool({ op: "undo", quote: "undo" })).toMatchObject({ applied: false });
    f.live.text = "undo";
    expect(f.tool({ op: "undo", quote: "undo" })).toEqual({ applied: true });
    expect(f.state.pick("bot", "thread", "task")).toBeUndefined();
    expect(f.rows.at(-1)).toMatchObject({ kind: "undo", undoable: false });
  });

  it("does not enable absent bots or record raw quotes/account/cost in rows", () => {
    const f = fixture();
    f.tool(pick);
    expect(f.state.get("other")).toBeUndefined();
    expect(JSON.stringify(f.rows)).not.toMatch(/quote|account|cost|Use Sol/);
    expect(f.rows[0]).toMatchObject({ kind: "pick", undoable: true, target: "worker" });
  });

  it("drops only the undone choice's habit row", () => {
    const f = fixture();
    f.tool(pick);
    const id = f.rows[0].id;
    const dimensions = { engine: "codex" as const, model: "gpt-6.1-sol", effort: "max" as const };
    for (const choiceId of [id, "b".repeat(32)]) {
      const choice = { actorId: "user", actionId: choiceId, origin: "chat" as const, target: "worker" as const, taskClass: "build" as const, dimensions, userQuote: "Sol max" };
      f.habits.observe({ choiceId, target: "worker", taskClass: "build", ...dimensions, origin: "chat", at: 1000 }, choice,
        { authenticatedUserId: "user", currentActionId: choiceId, authorized: true, target: "worker", taskClass: "build", intent: "choice", attributed: dimensions, directUserText: "Sol max" }, 1000, true);
    }
    expect(f.habits.rows()).toHaveLength(2);
    f.ops.undo("bot", "thread", id);
    expect(f.habits.rows().map((row) => row.choiceId)).toEqual(["b".repeat(32)]);
  });
});
