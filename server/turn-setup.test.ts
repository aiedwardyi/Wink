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
    const run = new Function("deps", `return (async () => { const { checkpoints, checkpointCwd, bot, threadId, currentTurnEpoch, epoch, rewound, watchdog, dispatchAdapterTurn } = deps; ${script} })();`);
    const pending = run({
      checkpoints: { snapshot }, checkpointCwd: "/project", bot: { id: "bot" }, threadId: "thread",
      currentTurnEpoch: () => 1, epoch: 1, rewound: false, watchdog: { watch: vi.fn() }, dispatchAdapterTurn,
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
