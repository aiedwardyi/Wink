import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { renderSkillInstructions } from "./skill-library.ts";
import { workspaceDir } from "./workspace.ts";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);

function nodes<T extends ts.Node>(guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node) {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe("turn setup", () => {
  it.each([
    ["direct", 0, 0, true], ["peer", 0, 1, true], ["room", 1, 0, true], ["peer room", 1, 1, true],
    ["unsupported", 0, 0, false], ["unsupported room", 1, 1, false],
  ] as const)("mounts agents by capability for %s turns", (_, index, depth, capable) => {
    const mounts = nodes(ts.isIfStatement).filter((node) => node.thenStatement.getText(source).includes("integrations.agents = agentsIntegration("));
    expect(mounts).toHaveLength(2);
    const integration = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "agentsIntegration")!;
    const script = ts.transpileModule(integration.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const agentsIntegration = new Function("process", "agentsProxyPath", "AGENTS_NODE_FLAG", "PORT", "commsCallers", "teamReports", "autoRouting", `${script}; return agentsIntegration;`)(
      process, "/agents-proxy.ts", { ELECTRON_RUN_AS_NODE: "1" }, 8799,
      { token: () => "fixture-token" }, { prompt: () => "" }, { state: { get: () => undefined } },
    );
    const integrations: Record<string, { env: Record<string, string> }> = {};
    const run = new Function("integrations", "instance", "bot", "threadId", "commsDepth", "hop", "MAX_COMMS_DEPTH", "agentsIntegration", mounts[index]!.getText(source));
    run(integrations, { adapter: { capabilities: { agentsMcp: capable } } }, { id: "peer" }, "peer-thread", depth, depth, 1, agentsIntegration);
    if (capable) expect(integrations.agents?.env).toMatchObject({
      OMB_BOT_ID: "peer", OMB_THREAD_ID: "peer-thread", OMB_COMMS_TOKEN: "fixture-token", OMB_TURN_DEPTH: String(depth),
    });
    else expect(integrations.agents).toBeUndefined();
  });

  it.each([0, 1])("keeps coordination limits with agents mounted on path %s", (index) => {
    const declarations = nodes(ts.isVariableDeclaration);
    const gate = declarations.filter((node) => node.name.getText(source) === "canMessage")[index];
    const coordination = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "chiefOfStaffSystemPrompt")[index]!;
    const evaluate = new Function("integrations", "commsDepth", "hop", "MAX_COMMS_DEPTH", `const canMessage = ${gate?.initializer?.getText(source) ?? "Boolean(integrations.agents)"}; return ${coordination.arguments[2]!.getText(source)};`);
    expect(evaluate({ agents: {} }, 0, 0, 1)).toBe(true);
    expect(evaluate({ agents: {} }, 1, 1, 1)).toBe(false);
  });

  it("dispatches without waiting for a workspace snapshot", async () => {
    const declarations = nodes(ts.isVariableDeclaration);
    const setupEnd = declarations.find((node) => node.name.getText(source) === "showImagePrompt")!;
    const dispatch = declarations.find((node) => node.name.getText(source) === "started" && node.initializer?.getText(source).startsWith("await dispatchAdapterTurn("))!;
    const prefix = source.text.slice(setupEnd.parent.parent.end, dispatch.parent.parent.getStart(source));
    const script = ts.transpileModule(`${prefix}\nawait dispatchAdapterTurn(threadId, async () => {});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const dispatchAdapterTurn = vi.fn(async () => true);
    const snapshot = vi.fn(() => new Promise(() => {}));
    const run = new Function("deps", `return (async () => { const { checkpoints, checkpointCwd, bot, threadId, currentTurnEpoch, epoch, rewound, watchdog, turnRegistry, commsDepth, rootId, userKeys, dispatchAdapterTurn } = deps; ${script} })();`);
    const pending = run({
      checkpoints: { snapshot }, checkpointCwd: "/project", bot: { id: "bot" }, threadId: "thread",
      currentTurnEpoch: () => 1, epoch: 1, rewound: false, watchdog: { watch: vi.fn() }, turnRegistry: { prepare: vi.fn() }, commsDepth: 0, rootId: null, userKeys: [], dispatchAdapterTurn,
    });
    await Promise.resolve();
    expect(snapshot).not.toHaveBeenCalled();
    expect(dispatchAdapterTurn).toHaveBeenCalledOnce();
    await pending;
  });

  it.each([["direct", 0], ["room", 1]] as const)("loads old workspace skills in the %s bot prompt", (_, index) => {
    const workspace = workspaceDir(`prompt-${index}`);
    mkdirSync(join(workspace, "skills", "review"), { recursive: true });
    writeFileSync(join(workspace, "skills", "skills.json"), JSON.stringify({
      review: { description: "Review an existing project", enabled: true },
    }));
    writeFileSync(join(workspace, "skills", "review", "SKILL.md"), "Review the project carefully.");
    const calls = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "renderSkillInstructions");
    expect(calls).toHaveLength(2);
    const render = new Function("renderSkillInstructions", "selectedSkills", "worksInWorkspace", "opts", "privateWorkspace", "workspace", `return ${calls[index]!.getText(source)};`);
    const prompt = render(renderSkillInstructions, [], true, undefined, workspace, workspace);
    expect(prompt).toContain("- review: Review an existing project");
    expect(prompt).toContain(JSON.stringify(join(workspace, "skills")));
    expect(render(renderSkillInstructions, [], false, undefined, undefined, undefined)).toBe("");
  });
});
