import { afterEach, describe, expect, it, vi } from "vitest";

import { callTool, spawnTerminalPane, TOOLS, terminalTools } from "./drivers/terminal-proxy.ts";
import { harnessPlaybookPrompt, loadHarnessPlaybook } from "./harness-playbook.ts";

const task = { prompt: "Read card.md and do it.", kind: "edit", risk: "low", scope: "bounded" };
const pin = { model: "claude-opus-5-5", effort: "high", userQuote: "use Opus high" };
const CONFIG = { host: "http://host", token: "t", botId: "bot" };
type Schema = { enum?: string[]; required?: string[]; properties?: Record<string, Schema> };
type SpawnTool = { description: string; properties: Record<string, Schema> };
const spawnTool = (tools: readonly { name: string }[]): SpawnTool => {
  const tool = JSON.parse(JSON.stringify(tools.find((item) => item.name === "terminal_spawn")));
  return { description: tool.description, properties: tool.inputSchema.properties };
};

function bodies() {
  const calls: unknown[] = [];
  const fake = vi.fn<typeof fetch>(async (_url, init) => {
    calls.push(JSON.parse(String(init!.body)));
    return Response.json({ sessionId: "pane", generation: 1 });
  });
  return { calls, fake };
}

afterEach(() => vi.unstubAllEnvs());

describe("auto tool text", () => {
  it("keeps the Auto-off tools untouched", () => {
    const before = JSON.stringify(TOOLS);
    const auto = terminalTools(true);
    expect(terminalTools(false)).toBe(TOOLS);
    expect(JSON.stringify(TOOLS)).toBe(before);
    expect(auto).not.toBe(TOOLS);
    expect(Object.keys(spawnTool(TOOLS).properties)).toEqual(["label", "cwd", "command"]);
  });

  it("adds task and pin to the Auto-on spawn schema", () => {
    const spawn = spawnTool(terminalTools(true));
    const { task: taskSchema, pin: pinSchema } = spawn.properties;
    const fields = taskSchema.properties!;
    expect(Object.keys(spawn.properties)).toEqual(["label", "cwd", "command", "task", "pin"]);
    expect(fields.kind.enum).toContain("build");
    expect(fields.risk.enum).toEqual(["low", "high", "protected", "unknown"]);
    expect(fields.scope.enum).toEqual(["bounded", "mechanical", "multi-source", "large", "unknown"]);
    expect(taskSchema.required).toEqual(["prompt", "kind", "risk", "scope"]);
    expect(Object.keys(fields)).toEqual(["prompt", "kind", "risk", "scope", "tools", "reviewOf"]);
    expect(pinSchema.required).toEqual(["userQuote"]);
    expect(Object.keys(pinSchema.properties!)).toEqual(["model", "effort", "userQuote"]);
    expect(spawn.description).toMatch(/otherwise Auto picks, Main first/);
  });

  it("leaves the other Auto-on tools as they are", () => {
    expect(terminalTools(true).map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(terminalTools(true).filter((tool) => tool.name !== "terminal_spawn")).toEqual(TOOLS.filter((tool) => tool.name !== "terminal_spawn"));
  });
});

describe("auto spawn forwarding", () => {
  it("forwards task and pin without a command", async () => {
    const { calls, fake } = bodies();
    await spawnTerminalPane({ label: "B", cwd: "D:\\w", task, pin }, fake, { ...CONFIG, auto: true });
    expect(calls).toEqual([{ label: "B", cwd: "D:\\w", auto: { task, pin } }]);
  });

  it("forwards a task alone and reads the flag from the env", async () => {
    vi.stubEnv("OMB_AUTO_ROUTING", "1");
    const { calls, fake } = bodies();
    await spawnTerminalPane({ label: "B", task }, fake, CONFIG);
    expect(calls).toEqual([{ label: "B", auto: { task } }]);
  });

  it("lets config.auto override the env", async () => {
    vi.stubEnv("OMB_AUTO_ROUTING", "1");
    const { calls, fake } = bodies();
    await spawnTerminalPane({ label: "B", task, command: "echo hi" }, fake, { ...CONFIG, auto: false });
    expect(calls).toEqual([{ label: "B", command: "echo hi" }]);
  });

  it("ignores task and pin when Auto is off", async () => {
    const { calls, fake } = bodies();
    await spawnTerminalPane({ label: "B", cwd: "D:\\w", command: "echo hi", task, pin }, fake, CONFIG);
    expect(calls).toEqual([{ label: "B", cwd: "D:\\w", command: "echo hi" }]);
  });

  it("refuses a command beside a task", async () => {
    const { calls, fake } = bodies();
    await expect(spawnTerminalPane({ label: "B", task, command: "claude" }, fake, { ...CONFIG, auto: true })).rejects.toThrow(/task or command/i);
    expect(calls).toEqual([]);
  });

  it("still runs an explicit command with Auto on", async () => {
    const { calls, fake } = bodies();
    await spawnTerminalPane({ label: "B", command: "echo hi" }, fake, { ...CONFIG, auto: true });
    expect(calls).toEqual([{ label: "B", command: "echo hi" }]);
  });

  it.each([
    ["a missing prompt", { ...task, prompt: "" }],
    ["an unknown kind", { ...task, kind: "poetry" }],
    ["an unknown risk", { ...task, risk: "none" }],
    ["an unknown scope", { ...task, scope: "huge" }],
    ["a bad tools list", { ...task, tools: [1] }],
    ["a bad reviewOf", { ...task, reviewOf: { engine: "codex" } }],
    ["an extra key", { ...task, model: "x" }],
    ["a non-object", "build it"],
  ])("rejects a task with %s", async (_label, bad) => {
    const { calls, fake } = bodies();
    await expect(spawnTerminalPane({ label: "B", task: bad }, fake, { ...CONFIG, auto: true })).rejects.toThrow(/task/i);
    expect(calls).toEqual([]);
  });

  it.each([
    ["no quote", { model: "claude-opus-5-5" }],
    ["no model or effort", { userQuote: "use Opus" }],
    ["a non-string model", { model: 1, userQuote: "use Opus" }],
    ["an extra key", { ...pin, engine: "codex" }],
  ])("rejects a pin with %s", async (_label, bad) => {
    const { calls, fake } = bodies();
    await expect(spawnTerminalPane({ label: "B", task, pin: bad }, fake, { ...CONFIG, auto: true })).rejects.toThrow(/pin/i);
    expect(calls).toEqual([]);
  });

  it("rejects a pin without a task", async () => {
    await expect(spawnTerminalPane({ label: "B", pin }, bodies().fake, { ...CONFIG, auto: true })).rejects.toThrow(/pin/i);
  });

  it("skips spawn-usage for an Auto task and keeps the launch note", async () => {
    const urls: string[] = [];
    const fake = vi.fn<typeof fetch>(async (url) => {
      urls.push(String(url));
      return Response.json({ sessionId: "pane", generation: 2 });
    });
    const result = await callTool("terminal_spawn", fake, { ...CONFIG, harness: "http://h", commsToken: "c", auto: true }, { label: "B", task });
    expect(urls.some((url) => url.endsWith("/spawn-usage"))).toBe(false);
    expect(urls.some((url) => url.endsWith("/launch-note"))).toBe(true);
    expect(JSON.stringify(result)).toContain("sessionId pane (generation 2)");
  });

  it("returns the hold text of an Auto task", async () => {
    const fake = vi.fn<typeof fetch>(async () => Response.json({ sessionId: "", generation: 0, hold: "Codex is at its limit." }));
    const result = await callTool("terminal_spawn", fake, { ...CONFIG, harness: "http://h", commsToken: "c", auto: true }, { label: "B", task });
    expect(result).toEqual({ content: [{ type: "text", text: "Codex is at its limit." }] });
  });

  it("keeps spawn-usage for a command spawn with Auto off", async () => {
    const urls: string[] = [];
    const fake = vi.fn<typeof fetch>(async (url) => {
      urls.push(String(url));
      return Response.json({ sessionId: "pane", generation: 1 });
    });
    await callTool("terminal_spawn", fake, { ...CONFIG, harness: "http://h", commsToken: "c" }, { label: "B", command: "claude --model x" });
    expect(urls.some((url) => url.endsWith("/spawn-usage"))).toBe(true);
  });
});

describe("auto playbook", () => {
  const playbook = loadHarnessPlaybook();

  it("is byte-identical with Auto off", () => {
    expect(harnessPlaybookPrompt(true, playbook, false)).toBe(playbook);
    expect(harnessPlaybookPrompt(true)).toBe(playbook);
    expect(harnessPlaybookPrompt(false, playbook, false)).toBe("");
  });

  it("swaps the model-match block for one task line", () => {
    const prompt = harnessPlaybookPrompt(true, playbook, true);
    expect(prompt).not.toContain("Match the model to the job");
    expect(prompt).not.toContain("Save Gemini 4 Argon");
    expect(prompt).not.toContain("writing, X news.");
    expect(prompt).toMatch(/\n- [^\n]*task[^\n]*terminal_spawn[^\n]*Auto[^\n]*\n|\n- [^\n]*terminal_spawn[^\n]*task[^\n]*Auto[^\n]*\n/);
    expect(prompt.length).toBeLessThan(playbook.length);
    expect(prompt).toContain("## Audit cards");
  });

  it("leaves a terminal-less bot empty", () => {
    expect(harnessPlaybookPrompt(false, playbook, true)).toBe("");
  });
});
