import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { KEPT_LIMITS, NAMED_GUARDS, PENDING_LIMITS, PROMPT_WORDING } from "./limits.ts";
import { asksBlock, asksNudge, type TaskAsk } from "./task-asks.ts";
import { taskRecordBlock } from "./turn-context.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const scanned = /^(?:server|src|electron|shared)\/(?!vendor\/|testing\/).+\.(?:[cm]?[jt]s|tsx)$/;
const skipped = /\.(?:test|node-test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const phrase = /\b(?:at most|limited to|keeps \d+)\b/i;
const constant = /^MAX_[A-Z0-9_]+$/;

interface Hit { file: string; line: number; text: string; constant: boolean }

function limitHits(file: string, source: string): Hit[] {
  if (!phrase.test(source) && !source.includes("MAX_")) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : undefined);
  const hits: Hit[] = [];
  const at = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && constant.test(node.name.text) && /^\d/.test(node.initializer?.getText(tree) ?? "")) {
      hits.push({ file, line: at(node), text: node.name.text, constant: true });
    }
    const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    if (literal && phrase.test(node.text)) hits.push({ file, line: at(node), text: node.text, constant: false });
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return hits;
}

const registered: Record<string, Record<string, string>> = {};
for (const limits of [KEPT_LIMITS, PROMPT_WORDING, PENDING_LIMITS]) {
  for (const [file, finds] of Object.entries(limits)) registered[file] = { ...registered[file], ...finds };
}

function checkLimits(files: readonly string[], read: (file: string) => string): string[] {
  const used = new Set<string>();
  const unknown = files.flatMap((file) => limitHits(file, read(file))).filter((hit) => {
    const key = Object.keys(registered[hit.file] ?? {}).find((find) => hit.constant ? find === hit.text : hit.text.includes(find));
    if (key) used.add(`${hit.file}\0${key}`);
    return !key;
  }).map((hit) => `New limit found at ${hit.file}:${hit.line}. Wink adds no limits over the user. Remove it, or add it to server/limits.ts with the crash, data loss or runaway loop it prevents.`);
  const stale = Object.entries(registered).flatMap(([file, finds]) => files.includes(file)
    ? Object.keys(finds).filter((find) => !used.has(`${file}\0${find}`)).map((find) => `server/limits.ts lists "${find}" in ${file}, which no longer has it; drop the entry.`)
    : []);
  return [...unknown, ...stale];
}

const selected = (files: readonly string[]) => files.filter((file) => scanned.test(file) && !skipped.test(file) && file !== "server/limits.ts");
const tracked = () => selected(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", windowsHide: true }).split("\0"));
const readTracked = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("limits registry", () => {
  it("fails on a new cap or refusal outside the registry", () => {
    const planted = 'export const MAX_OPEN_TABS = 8;\nthrow new Error("you can keep at most 8 tabs");\n';
    expect(checkLimits(["src/planted.ts"], () => planted)).toEqual([
      "New limit found at src/planted.ts:1. Wink adds no limits over the user. Remove it, or add it to server/limits.ts with the crash, data loss or runaway loop it prevents.",
      "New limit found at src/planted.ts:2. Wink adds no limits over the user. Remove it, or add it to server/limits.ts with the crash, data loss or runaway loop it prevents.",
    ]);
  });

  it("ignores comments, non-numeric MAX_ names and other phrases", () => {
    expect(checkLimits(["server/planted.ts"], () => '// at most one\nconst MAX_NAME = name;\nconst limit = 8;\nconst note = "keeps going";\n')).toEqual([]);
  });

  it("flags a registered file's new cap and an entry its file dropped", () => {
    const [file, finds] = Object.entries(KEPT_LIMITS)[0]!;
    expect(checkLimits([file], () => `${readTracked(file)}\nconst MAX_PLANTED_CAP = 3;\n`)).toHaveLength(1);
    expect(checkLimits([file], () => "")).toHaveLength(Object.keys(finds).length);
  });

  it("scans every app source folder and skips tests, types and the registry", () => {
    expect(selected(["server/a.ts", "src/b.tsx", "electron/c.mjs", "shared/planted.ts", "shared/planted.test.ts", "shared/d.d.ts", "server/limits.ts", "server/testing/e.ts", "docs/f.ts"]))
      .toEqual(["server/a.ts", "src/b.tsx", "electron/c.mjs", "shared/planted.ts"]);
  });

  it("flags a new constant whose name only extends a registered one", () => {
    const file = "electron/error-reports.mjs";
    expect(KEPT_LIMITS[file]).toHaveProperty("MAX_BYTES");
    expect(checkLimits([file], () => `${readTracked(file)}\nconst MAX_BYTES_PER_USER = 8;\n`)).toEqual([
      expect.stringContaining(`New limit found at ${file}:`),
    ]);
  });

  it("holds every limit in the repo", () => {
    expect(checkLimits(tracked(), readTracked)).toEqual([]);
  });

  it("shows bots every open ask, never a count cap or a ceiling under 300 full-length asks", () => {
    const now = Date.now();
    const asks: TaskAsk[] = Array.from({ length: 300 }, (_, index) => ({ id: `A${index + 1}`, ask: "가".repeat(80), status: "open", ref: "r".repeat(80), at: now, changedAt: now }));
    const unjudged = asks.map(({ ref: _, ...ask }) => ({ ...ask, changedAt: 0 }));
    const record = (list: TaskAsk[]) => ({ goal: "Ship", plan: [], completed: [], blockers: [], nextAction: "", asks: list });
    const rule = "Bots see every open ask on every turn that carries the list (ASKS-OPEN, 11-19). Remove the count cap or slice; MAX_STATUS_ASKS_BYTES is only a crash ceiling and must fit 300 full-length asks.";
    for (const block of [asksBlock(asks, now), asksNudge(asks, now, "status?"), asksNudge(unjudged, now, "thanks"), taskRecordBlock(record(asks), 512, { now }), taskRecordBlock(record(unjudged), 512, { now, recovering: true })]) {
      expect(block.split("\n").filter((line) => line.startsWith("- A")).length, rule).toBe(300);
    }
  });

  it("keeps every named guard in place", () => {
    const missing = Object.entries(NAMED_GUARDS).flatMap(([file, finds]) => Object.keys(finds).filter((find) => !readTracked(file).includes(find)).map((find) => `${file}: ${find}`));
    expect(missing).toEqual([]);
  });
});
