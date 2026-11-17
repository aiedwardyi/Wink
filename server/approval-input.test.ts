import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { autoVerdict, guardInput, type AutoApprover } from "./auto-approve.ts";

const scratch = process.env.ORBIT_SCRATCH ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const fixture = realpathSync.native(mkdtempSync(join(scratch, "approval-input-")));
const project = join(fixture, "project");
const outside = join(fixture, "outside");
mkdirSync(project);
mkdirSync(outside);
writeFileSync(join(project, "keep.txt"), "keep");
writeFileSync(join(outside, "keep.txt"), "keep");
symlinkSync(outside, join(project, "shared"), process.platform === "win32" ? "junction" : "dir");

const source = (path: string) => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const js = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;

function find(root: ts.Node, matches: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const walk = (node: ts.Node) => {
    if (matches(node)) found = node;
    else ts.forEachChild(node, walk);
  };
  walk(root);
  if (!found) throw new Error("approval source missing");
  return found;
}

function opened(driver: string, input: Record<string, unknown>, tool = "Bash") {
  const file = source(`./drivers/${driver}.ts`);
  const event = find(file, (node) => ts.isCallExpression(node) && node.expression.getText(file) === "emit"
    && !!node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])
    && node.arguments[0].properties.some((prop) => ts.isPropertyAssignment(prop) && prop.name.getText(file) === "type" && prop.initializer.getText(file) === '"request.opened"')
    && !node.arguments[0].properties.some((prop) => ts.isPropertyAssignment(prop) && prop.name.getText(file) === "requestType" && prop.initializer.getText(file) === '"question"')) as ts.CallExpression;
  const helpers = driver === "claude" ? ["askArgs", "askSummary"].map((name) => find(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(file)).join("\n") : "";
  const scope = {
    base: () => ({}), threadId: "thread", eventTurnId: "turn", turnId: "turn", requestId: "request",
    ask: { id: "request", kind: "permission", tool, input }, tool, summary: String(input.command ?? "tool").slice(0, 200),
    approvalScope: undefined, controlsHost: false, unattended: true, inputDigest: () => "digest", guardInput,
    params: driver === "msp/runtime" ? { ...input, rawArgs: input.command, toolName: tool } : input,
    toolCall: { rawInput: input }, args: String(input.command ?? "tool"), isQuestion: false, isMcpElicitation: false, choices: [],
  };
  if (driver !== "claude") {
    const summary = find(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === "summary" && !!node.initializer
      && (driver === "codex" ? node.initializer.getText(file).includes("isMcpElicitation") : driver === "msp/runtime" ? node.initializer.getText(file).includes("params?.rawArgs") : node.initializer.getText(file) === "args.slice(0, 200)")) as ts.VariableDeclaration;
    scope.summary = new Function(...Object.keys(scope), js(`return (${summary.initializer!.getText(file)});`))(...Object.values(scope));
  }
  return new Function(...Object.keys(scope), js(`${helpers}\nreturn (${event.arguments[0].getText(file)});`))(...Object.values(scope));
}

const index = source("./index.ts");
const verdict = find(index, (node) => ts.isVariableDeclaration(node) && node.name.getText(index) === "verdict"
  && !!node.initializer && node.initializer.getText(index).includes("autoVerdict(asker")) as ts.VariableDeclaration;

function decide(event: Record<string, unknown>, unattended = true, bot: AutoApprover = { autoApprove: true }) {
  const scope = {
    permission: true, asker: bot, event, readOnly: false, cardless: false, unattended, autoVerdict,
    turnCwdByThread: new Map([["thread", project]]),
  };
  return new Function(...Object.keys(scope), js(`return (${verdict.initializer!.getText(index)});`))(...Object.values(scope)) as ReturnType<typeof autoVerdict>;
}

describe("approval input", () => {
  for (const driver of ["claude", "codex", "acp/core", "msp/runtime"]) {
    it(`${driver} denies the destructive tail beyond the card summary`, () => {
      const command = `echo ${"a".repeat(205)}; rm -rf "${outside}"`;
      expect(decide(opened(driver, { command }))).toMatchObject({ approve: null, source: "unattended-deny" });
    });

    it(`${driver} approves a whole harmless command`, () => {
      expect(decide(opened(driver, { command: `echo ${"a".repeat(205)}` }))).toMatchObject({ source: "auto-mode" });
    });

    it(`${driver} refuses oversized input instead of judging its summary`, () => {
      expect(decide(opened(driver, { command: `echo ${"a".repeat(65_536)}` }))).toMatchObject({ approve: null, source: "unattended-deny" });
    });

    it(`${driver} checks input beyond the displayed command`, () => {
      expect(decide(opened(driver, { command: "echo safe", script: "git reset --hard" }))).toMatchObject({ approve: null, source: "unattended-deny" });
    });
  }

  it("checks every tool's complete input", () => {
    const event = opened("claude", { prefix: "a".repeat(205), command: "git reset --hard" }, "mcp__custom__execute");
    expect(decide(event)).toMatchObject({ approve: null, source: "unattended-deny" });
  });

  it("denies missing or unreadable input when unattended", () => {
    const event = { tool: "Bash", summary: "echo safe", requestId: "request", threadId: "thread" };
    expect(decide(event)).toMatchObject({ approve: null, source: "unattended-deny" });
    expect(decide({ ...event, actionRefused: "unreadable" })).toMatchObject({ approve: null, source: "unattended-deny" });
  });

  it("keeps attended Auto and remembered command grants", () => {
    const event = opened("claude", { command: "git reset --hard" });
    expect(decide(event, false)).toMatchObject({ source: "auto-mode" });
    expect(decide(opened("claude", { command: "git status" }), false, { autoApprove: false, alwaysAllow: ["Bash:git"] })).toMatchObject({ source: "always-allow" });
  });
});

describe("resolved delete paths", () => {
  const away = { unattended: true, workspace: project };
  const bot = { autoApprove: true };

  it("denies a file reached through an in-project junction", () => {
    expect(autoVerdict(bot, "Bash", `rm "${join(project, "shared", "keep.txt")}"`, away)).toMatchObject({ approve: null, source: "unattended-deny" });
  });

  it("fails closed for an unresolvable target", () => {
    expect(autoVerdict(bot, "Bash", `rm "${join(project, "missing.txt")}"`, away)).toMatchObject({ approve: null, source: "unattended-deny" });
  });

  it("approves a plain in-project delete", () => {
    expect(autoVerdict(bot, "Bash", `rm "${join(project, "keep.txt")}"`, away)).toMatchObject({ source: "auto-mode" });
  });

  it("compares real paths when the workspace itself is a junction", () => {
    const alias = join(fixture, "alias");
    symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
    expect(autoVerdict(bot, "Bash", `rm "${join(alias, "keep.txt")}"`, { ...away, workspace: alias })).toMatchObject({ source: "auto-mode" });
  });
});
