import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { location, parseSource, readSource, runCheck, testFile, trackedFiles, walk } from "./repo-check.mjs";

// A sleep guesses how long the event takes: too short fails on a loaded runner, and no length proves a thing did not happen.
const allowedUrl = new URL("./test-sleeps.json", import.meta.url);
const hooks = /^(?:it|test|describe|beforeEach|afterEach|beforeAll|afterAll)\b/;
const timers = /^(?:node:)?timers\/promises$/;

const isFunction = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
const waits = (delay) => delay !== undefined && !(ts.isNumericLiteral(delay) && Number(delay.text) === 0);

function only(body) {
  if (!ts.isBlock(body)) return body;
  const [statement, more] = body.statements;
  if (!statement || more) return undefined;
  return ts.isExpressionStatement(statement) || ts.isReturnStatement(statement) ? statement.expression : undefined;
}

// new Promise((resolve) => setTimeout(resolve, ms)): a delay and nothing else. A value passed to resolve is a late fake reply, not a sleep.
function sleepPromise(node) {
  if (!ts.isNewExpression(node) || node.expression.getText() !== "Promise" || node.arguments?.length !== 1) return false;
  const [executor] = node.arguments;
  const param = isFunction(executor) && executor.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return false;
  const resolve = param.text;
  let timer = only(executor.body);
  if (timer && ts.isVoidExpression(timer)) timer = timer.expression;
  if (timer && ts.isCallExpression(timer) && ts.isPropertyAccessExpression(timer.expression) && timer.expression.name.text === "unref") timer = timer.expression.expression;
  if (!timer || !ts.isCallExpression(timer) || !/^(?:globalThis\.|window\.)?setTimeout$/.test(timer.expression.getText())) return false;
  const [callback, delay] = timer.arguments;
  if (!callback || !waits(delay)) return false;
  if (ts.isIdentifier(callback)) return callback.text === resolve;
  const call = isFunction(callback) && only(callback.body);
  return !!call && ts.isCallExpression(call) && call.expression.getText() === resolve && !call.arguments.length;
}

// A wait inside a loop is a poll for a condition; a loop that only declares tests is not.
function polls(node) {
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    if (ts.isIterationStatement(parent, false)) return true;
    if (isFunction(node) && ts.isCallExpression(parent) && hooks.test(parent.expression.getText())) return false;
  }
  return false;
}

export function testSleepHits(file, text) {
  if (!text.includes("setTimeout") && !text.includes("timers/promises")) return [];
  const source = parseSource(file, text);
  const helpers = new Set();
  const inner = new Set();
  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && timers.test(node.moduleSpecifier.text)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const item of named.elements) if ((item.propertyName ?? item.name).text === "setTimeout") helpers.add(item.name.text);
    }
    const body = isFunction(node) && node.body ? only(node.body) : undefined;
    const name = body && sleepPromise(body) && (node.name ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined));
    if (name && ts.isIdentifier(name)) {
      helpers.add(name.text);
      inner.add(body);
    }
  });
  const hits = [];
  walk(source, (node) => {
    const helper = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text) && (!node.arguments.length || waits(node.arguments[0]));
    if ((helper || (sleepPromise(node) && !inner.has(node))) && !polls(node)) hits.push({ file, line: location(source, node) });
  });
  return hits;
}

const readAllowed = () => JSON.parse(readFileSync(allowedUrl, "utf8"));

export function checkTestSleeps(files = trackedFiles(testFile), read = readSource, allowed = readAllowed()) {
  const out = [];
  for (const file of files) {
    const hits = testSleepHits(file, read(file));
    const limit = allowed[file] ?? 0;
    for (const hit of hits.slice(limit)) {
      out.push(`${hit.file}:${hit.line}: sleep in a test (this file may hold ${limit}); wait on the event with vi.waitFor or the file's until helper, hold a fake reply behind a promise the test resolves, or drive time with vi.useFakeTimers()`);
    }
    if (hits.length < limit) out.push(`${file}: test-sleeps.json allows ${limit} sleeps but the file has ${hits.length}; run node scripts/check-test-sleeps.mjs --lower`);
  }
  return out;
}

// Counts only go down: a new sleep is never written into the list.
function lower() {
  const allowed = readAllowed();
  const next = {};
  for (const file of trackedFiles(testFile)) {
    const count = Math.min(allowed[file] ?? 0, testSleepHits(file, readSource(file)).length);
    if (count) next[file] = count;
  }
  writeFileSync(allowedUrl, `${JSON.stringify(next, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv.includes("--lower")) lower();
runCheck(import.meta.url, checkTestSleeps);
