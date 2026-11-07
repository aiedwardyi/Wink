import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { selectAutoRoute, SHIPPED_AUTO_RULES, type AutoCandidate } from "../shared/auto-routing.ts";
import { AutoRoutingRules, type RuleAuthorization } from "./auto-routing-rules.ts";
import { names, ruleAuthorization, userChoice, userWords, type AttributionSource } from "./auto-routing-attrib.ts";
import { DATA_DIR } from "./config.ts";
import { TurnRegistry } from "./turn-registry.ts";

describe("live Auto attribution", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const body = source.match(/function turnStartedByUser\(opts\?: StartTurnOptions\): boolean \{([\s\S]*?)\n\}/)![1];
  const byUser = new Function("opts", body);
  it.each([
    ["ask_bot", { commsDepth: 1 }], ["delegation", { commsDepth: 1 }], ["routine", { automationSource: "routine" }],
    ["worker report", { cardContinuation: true }], ["pane wake", { cardContinuation: true, paneNoteWake: true }],
    ["keep-going", { cardContinuation: true }], ["limit-wait", { cardContinuation: true, limitWaitId: "wait" }],
    ["resume", { cardContinuation: true }], ["provider continuation", null], ["room", null], ["synced", null],
  ])("records no user keys for %s", (kind, flags) => {
    const registry = new TurnRegistry();
    const userKeys = flags && byUser(flags) ? ["typed"] : [];
    registry.prepare({ botId: "bot", threadId: "thread", owner: kind === "room" ? "room" : "user", depth: 0, userKeys });
    registry.started("turn", "thread");
    expect(registry.current("thread")).toHaveProperty("userKeys", []);
  });

  it.each(["typed send", "queued drain", "peer-user reply"])("captures the direct message key for %s", () => {
    const registry = new TurnRegistry();
    registry.prepare({ botId: "bot", threadId: "thread", owner: "user", depth: 0, userKeys: byUser({}) ? ["typed"] : [] });
    registry.started("turn", "thread");
    expect(registry.current("thread")?.userKeys).toEqual(["typed"]);
    expect(source).toContain('depth: commsDepth, rootId, userKeys');
  });

  it("appends a steered human key without duplicating it", () => {
    const registry = new TurnRegistry();
    registry.start("turn", { botId: "bot", threadId: "thread", owner: "user", depth: 0 });
    for (let i = 0; i < 2; i++) registry.adoptRoot("thread", "root", "steered");
    expect(registry.current("thread")).toHaveProperty("userKeys", ["steered"]);
  });

  it("accepts a verified name-free rule without a second operation parser", () => {
    const directory = join(DATA_DIR, "attrib-red-rules");
    mkdirSync(directory, { recursive: true });
    const rules = new AutoRoutingRules(directory);
    const authorization: RuleAuthorization = { authenticatedUserId: "user", actorId: "user", authorized: true, actionId: "turn", currentActionId: "turn",
      directUserText: "reset Auto", userQuote: "reset Auto", origin: "direct-user", attributed: {} };
    expect(() => rules.apply({ op: "reset" }, authorization)).not.toThrow();
    expect(rules.current().id).toBe(1);
  });

  it("honors explicit verified effort without enabling the Max rule", () => {
    const candidate: AutoCandidate = { engine: "codex", account: "base", generation: 0, currentGeneration: 0,
      authorized: true, signedIn: true, lifecycle: "ready", subscription: true, models: ["gpt-6.1-sol"], effortLevels: ["high", "max"],
      tools: [], contextTokens: 100000, pending: 0, active: 0, loadKnown: true, main: true };
    expect(selectAutoRoute({ target: "worker", task: { kind: "build", risk: "low", scope: "bounded", source: "declared" }, now: Date.now(),
      candidates: [candidate], rules: structuredClone(SHIPPED_AUTO_RULES), rulesVersion: 0,
      pin: { engine: "codex", model: "gpt-6.1-sol", effort: "max" }, pinVerified: true,
    })).toMatchObject({ kind: "selected", route: { effort: "max" } });
  });
});

const dimensions = { engine: "codex" as const, model: "gpt-6.1-sol", effort: "max" as const };
function source(text = "switch to Sol max"): AttributionSource {
  return { botId: "bot", threadId: "thread", ownerId: "user", authorized: true,
    turn: { botId: "bot", threadId: "thread", turnId: "a".repeat(32), owner: "user", depth: 0, rootId: null, userKeys: ["typed"], nowWatch: [] },
    messages: [{ id: "typed", role: "user", kind: "text", text, at: 1 }] };
}

describe("cited user words", () => {
  it("uses only live keyed lines and creates server-owned provenance", () => {
    const s = source();
    s.messages = [{ id: "prior", role: "user", kind: "text", text: "Use Opus", at: 0 }, ...s.messages];
    expect(userWords(s)).toBe("switch to Sol max");
    expect(userChoice(s, "worker", "build", "Sol max", dimensions)).toMatchObject({
      choice: { actorId: "user", actionId: s.turn!.turnId, origin: "chat", dimensions },
      context: { directUserText: "switch to Sol max", attributed: dimensions },
    });
    expect(userChoice(source('<attached-file path="card.md"/> Use Sol max'), "worker", "build", "Sol max", dimensions)).toBeDefined();
  });

  it.each([
    ["paste chip", '<pasted-text>Sol max</pasted-text>'], ["file", '<attached-file path="Sol max" />'],
    ["code block", '```\nSol max\n```'], ["blockquote", '> Sol max'], ["quoted string", '"Sol max"'],
    ["inline code", '`Sol max`'], ["Korean quote", '「Sol max」'],
    ["tilde code block", '~~~\nSol max\n~~~'], ["indented code", '    Sol max'],
    ["file body", '<attached-file>Sol max</attached-file>'],
  ])("rejects %s", (_kind, text) => {
    expect(userChoice(source(text), "worker", "build", "Sol max", dimensions)).toBeUndefined();
  });

  it.each(["peer", "worker", "prior turn", "imported", "routine", "room", "different bot", "different thread", "not owner"])("rejects %s provenance", (kind) => {
    const s = source();
    if (kind === "peer") s.messages = [{ ...s.messages[0], from: { botId: "peer", name: "Peer", color: "blue" } }];
    if (kind === "worker") s.messages = [{ ...s.messages[0], kind: "note" }];
    if (kind === "prior turn") s.turn!.userKeys = ["new"];
    if (kind === "imported") s.messages = [{ ...s.messages[0], imported: true }];
    if (kind === "routine") s.messages = [{ ...s.messages[0], origin: "device" }];
    if (kind === "room") s.turn!.owner = "room";
    if (kind === "different bot") s.turn!.botId = "other";
    if (kind === "different thread") s.turn!.threadId = "other";
    if (kind === "not owner") s.authorized = false;
    expect(userChoice(s, "worker", "build", "Sol max", dimensions)).toBeUndefined();
  });

  it("rejects fabricated quotes, unnamed dimensions, accounts and conflicting names", () => {
    for (const [text, quote, choice] of [
      ["Sol max", "use Sol max", dimensions], ["Sol max", "max", dimensions], ["Opus max", "Opus max", dimensions],
      ["Sol high", "Sol high", dimensions], ["Sol or Opus max", "Sol or Opus max", dimensions],
      ["Sol high or max", "Sol high or max", dimensions], ["Sol max", "Sol max", { ...dimensions, account: "private" }],
    ] as const) expect(userChoice(source(text), "worker", "build", quote, choice)).toBeUndefined();
  });

  it.each([
    ["ChatGPT", "codex", "gpt-6.1-sol"], ["GPT", "codex", "gpt-6.1-sol"], ["Claude", "claudeAgent", "claude-opus-5-5"],
    ["Grok", "grokAgent", "grok-4.7"], ["Gemini", "antigravityAgent", "gemini-3.8-flash"],
    ["솔", "codex", "gpt-6.1-sol"], ["챗지피티", "codex", "gpt-6.1-sol"], ["클로드", "claudeAgent", "claude-opus-5-5"],
    ["오퍼스", "claudeAgent", "claude-opus-5-5"], ["소넷", "claudeAgent", "claude-sonnet-5-5"],
    ["그록", "grokAgent", "grok-4.7"], ["제미나이", "antigravityAgent", "gemini-3.8-flash"],
  ])("resolves %s", (label, engine, model) => {
    expect(names(`${label} 최대`)).toEqual({ engine, model, effort: "max" });
  });

  it("uses longest catalog names and preserves unspecified dimensions", () => {
    expect(names("Claude Sonnet 5.5 high")).toEqual({ engine: "claudeAgent", model: "claude-sonnet-5-5", effort: "high" });
    expect(names("클로드 소넷 높게")).toEqual({ engine: "claudeAgent", model: "claude-sonnet-5-5", effort: "high" });
    expect(names("Claude Haiku low")).toEqual({ engine: "claudeAgent", model: "claude-haiku-5-5", effort: "low" });
    expect(names("GPT-6.1 Terra high")).toEqual({ engine: "codex", model: "gpt-6.1-terra", effort: "high" });
    expect(names("Grok 4.6 xhigh")).toEqual({ engine: "grokAgent", model: "grok-4.6", effort: "xhigh" });
    expect(names("solution maximum")).toEqual({});
    expect(userChoice(source("Sol please"), "worker", "build", "Sol", { engine: "codex", model: "gpt-6.1-sol" })?.choice.dimensions).toEqual({ engine: "codex", model: "gpt-6.1-sol" });
    expect(userChoice(source("제미나이로"), "worker", "build", "제미나이", { engine: "antigravityAgent", model: "gemini-3.8-flash-high" })).toBeDefined();
  });

  it("requires model and effort names for rules but only the verified quote for reset", () => {
    const rules = new AutoRoutingRules(join(DATA_DIR, "attrib-names"));
    const op = { op: "setPreference" as const, preference: { target: "worker" as const, taskClass: "build" as const, ...dimensions } };
    expect(() => rules.apply(op, ruleAuthorization(source("Opus max"), op, "Opus max"))).toThrow();
    expect(rules.current().id).toBe(0);
    rules.apply(op, ruleAuthorization(source(), op, "Sol max"));
    const reset = { op: "reset" as const };
    rules.apply(reset, ruleAuthorization(source("reset Auto"), reset, "reset Auto"));
    expect(rules.current().id).toBe(2);
  });
});
