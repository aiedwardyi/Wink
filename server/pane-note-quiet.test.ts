// A pane-note turn stays quiet only when it answers worker notes alone.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

describe("pane-note quiet finish", () => {
  it("alerts when a user send folded into the start", () => {
    const at = index.indexOf("opts?.paneNoteWake === true");
    expect(at).toBeGreaterThan(0);
    const line = index.slice(index.lastIndexOf("\n", at) + 1, index.indexOf("\n", at));
    expect(line).toContain("folded");
    expect(line).toMatch(/folded\.length\s*===\s*0|!folded\.length/);
  });

  it.each(["\n", "\r\n"])("alerts when a late send joins at dispatch with %j endings", (ending) => {
    const source = ts.createSourceFile("index.ts", index.replace(/\r?\n/g, ending), ts.ScriptTarget.Latest, true);
    let callback: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "foldLate" && node.initializer && ts.isArrowFunction(node.initializer)) callback = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(callback).toBeDefined();
    const script = ts.transpileModule(callback!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const run = new Function("scope", `with (scope) { return (${script.trim().replace(/;$/, "")})(); }`);
    const paneNoteTurnThreads = new Set(["thread"]);
    const late: string[] = [];
    const foldQueuedSends = vi.fn((): string[] => []);
    const scope = { store: { activePath: () => [{ id: "human" }] }, bot: { id: "bot" }, threadId: "thread", claimMark: 0, rootId: null, late, foldPeerQueuedSends: foldQueuedSends, live: { adapter: { capabilities: { queueing: true } } }, adoptHumanRoot: vi.fn(() => "root"), clearUnattended: vi.fn(), resumePaneWakes: vi.fn(), paneNoteTurnThreads };
    run(scope);
    expect(paneNoteTurnThreads.has("thread")).toBe(true);
    foldQueuedSends.mockReturnValue(["late send"]);
    run(scope);
    expect(late).toEqual(["late send"]);
    expect(paneNoteTurnThreads.has("thread")).toBe(false);
  });

  it("alerts a continuation adopted after a note, keeps the note turn quiet", () => {
    const at = index.indexOf("adopt: (botId, threadId, turnId) => {");
    expect(at).toBeGreaterThan(0);
    expect(index.slice(at, at + 800)).toContain("paneNoteTurnThreads.delete(threadId)");
    expect(index).toContain("paneNoteTurn: paneNoteTurnThreads.has(event.threadId)");
  });
});
