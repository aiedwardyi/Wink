import ts from "typescript";
import { location, parseSource, readSource, runCheck, testFile, trackedFiles, walk } from "./repo-check.mjs";

// Check lifecycle dates regardless of year: a gate must not change as the clock advances.
const lifecycle = /^(?:resets?(?:at|time|atms)?|expir(?:y|es?|ation)(?:at|date|time|ms)?|fresh(?:until|at)|validuntil|retryat|resumes?at|future)$/i;
const isoDate = /^\d{4}-\d{2}-\d{2}(?:T|$)/;
const allowlist = [
  { file: "server/claude-usage-probe.test.ts", dates: { "2026-11-04T00:00:00Z": 2 }, reason: "Existing probe payload/expected parsing pair; no wall-clock expiry assertion." },
  { file: "server/drivers/rate-limits.test.ts", dates: {
    "2026-09-15T12:00:00Z": 3, "2026-10-11T08:45:16.197799+00:00": 1,
    "2026-09-21T12:00:00Z": 6, "2026-09-14T13:00:00Z": 6, "2026-09-14T17:00:00Z": 2,
  }, reason: "Existing parser expectations and quota fixtures with explicit now arguments." },
  { file: "server/openmaus-status-capsule.test.ts", dates: { "2026-08-22T06:35:00Z": 2 }, reason: "Existing capsule fixtures use the fixed NOW argument." },
  { file: "server/usage-refresh.test.ts", dates: {
    "2026-10-01T12:00:00Z": 1, "2026-10-29T15:09:59.696703+00:00": 1, "2026-11-02T07:59:59.696721+00:00": 1,
    "2026-11-05T07:02:43.495651+00:00": 1, "2026-11-01T08:45:16.197799+00:00": 1,
    "2026-09-01T17:00:00Z": 1, "2026-09-08T12:00:00Z": 1, "2026-10-10T17:03:32Z": 1,
  }, reason: "Existing recorded/parser and fake-CLI response expectations; retained without changing app or existing tests." },
  { file: "src/components/ChatView.usage-wait.test.ts", dates: { "2026-10-30T03:40:00Z": 1 }, reason: "Existing wait projection fixture; live usage reset is derived in mount()." },
  { file: "src/state/store.test.ts", dates: { "2026-09-24T10:00:00.000Z": 2, "2026-09-17T15:00:00.000Z": 1 }, reason: "Existing reducer preservation fixtures compare data without evaluating expiry." },
];

function fixedClock(node) {
  if (!node) return false;
  if (ts.isNumericLiteral(node) || ts.isStringLiteralLike(node)) return true;
  if (ts.isPrefixUnaryExpression(node)) return fixedClock(node.operand);
  if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
    return /^(?:Date|Date\.parse|Date\.UTC)$/.test(node.expression.getText()) &&
      node.arguments?.length > 0 && node.arguments.every(fixedClock);
  }
  return false;
}

export function fixtureDateHits(file, text) {
  if (!/\d{4}-\d{2}-\d{2}/.test(text)) return [];
  const source = parseSource(file, text);
  const hits = [];
  const frozen = new Set();
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || !/^(?:vi|vitest)\.setSystemTime$/.test(node.expression.getText(source)) || !fixedClock(node.arguments[0])) return;
    let scope = node.parent;
    while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
    if (!scope?.body) return;
    const hook = scope.parent;
    if (ts.isCallExpression(hook) && /^(?:beforeEach|beforeAll)$/.test(hook.expression.getText(source))) {
      let suite = hook.parent;
      while (suite && !ts.isBlock(suite) && !ts.isSourceFile(suite)) suite = suite.parent;
      frozen.add(suite);
    } else frozen.add(scope.body);
  });
  walk(source, (node) => {
    if (!ts.isStringLiteralLike(node) || !isoDate.test(node.text) || !Number.isFinite(Date.parse(node.text))) return;
    let parent = node.parent;
    while (parent && !ts.isStatement(parent)) {
      if (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent) || ts.isBinaryExpression(parent)) {
        const name = (parent.name ?? parent.left)?.getText(source).replace(/["'_.]/g, "") ?? "";
        if (!lifecycle.test(name)) break;
        let scope = node.parent;
        while (scope && !frozen.has(scope)) scope = scope.parent;
        if (!scope) hits.push({ file, line: location(source, node), date: node.text });
        break;
      }
      parent = parent.parent;
    }
  });
  return hits;
}

export function checkFixtureDates(files = trackedFiles(testFile), read = readSource) {
  const counts = new Map();
  return files.flatMap((file) => fixtureDateHits(file, read(file)))
    .filter((hit) => {
      const entry = allowlist.find((entry) => entry.file === hit.file && entry.dates[hit.date]);
      if (!entry) return true;
      const key = `${hit.file}:${hit.date}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count > entry.dates[hit.date];
    })
    .map((hit) => `${hit.file}:${hit.line}: pinned lifecycle date ${hit.date}; derive it from the fixture clock or freeze time`);
}

runCheck(import.meta.url, checkFixtureDates);
