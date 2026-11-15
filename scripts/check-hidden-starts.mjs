import ts from "typescript";
import { location, parseSource, readSource, runCheck, trackedFiles, walk } from "./repo-check.mjs";

// On Windows a console child started without windowsHide by a parent that has no console opens a terminal window.
const starts = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const scanned = /^(?:server|electron|shared)\/(?!vendor\/).+\.[cm]?[jt]s$/;
const moduleName = /^(?:node:)?child_process$/;
const allowlist = [
  { file: "electron/build-speech-helper.mjs", starts: 4, reason: "macOS build step: swiftc, lipo and codesign do not exist on Windows." },
  { file: "electron/cua.mjs", starts: 1, reason: "macOS only: opens CuaDriver.app through LaunchServices." },
  { file: "electron/speech.mjs", starts: 1, reason: "macOS only: /usr/bin/open starts the speech helper bundle." },
  { file: "server/env-path.ts", starts: 1, reason: "Login shell PATH probe; returns before it on Windows." },
  { file: "server/codex-credit.test.ts", starts: 1, reason: "/bin/sh; only runs off Windows." },
  { file: "server/computer-proxy.test.ts", starts: 1, reason: "/bin/bash syntax check; only runs off Windows." },
  { file: "server/remote-computer.test.ts", starts: 1, reason: "/bin/bash syntax check; only runs off Windows." },
];

const isRequire = (node) => node && ts.isCallExpression(node) && node.expression.getText() === "require" &&
  node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) && moduleName.test(node.arguments[0].text);

export function hiddenStartHits(file, text) {
  if (!text.includes("child_process")) return [];
  const source = parseSource(file, text);
  const direct = new Map();
  const modules = new Set();
  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && moduleName.test(node.moduleSpecifier.text) && node.importClause && !node.importClause.isTypeOnly) {
      const { name, namedBindings } = node.importClause;
      if (name) modules.add(name.text);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) modules.add(namedBindings.name.text);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const item of namedBindings.elements) {
          const original = (item.propertyName ?? item.name).text;
          if (!item.isTypeOnly && starts.has(original)) direct.set(item.name.text, original);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && isRequire(node.initializer)) {
      if (ts.isIdentifier(node.name)) modules.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const item of node.name.elements) {
          const original = (item.propertyName ?? item.name).getText(source);
          if (ts.isIdentifier(item.name) && starts.has(original)) direct.set(item.name.text, original);
        }
      }
    }
  });
  const hits = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    let name;
    if (ts.isIdentifier(callee)) name = direct.get(callee.text);
    else if (ts.isPropertyAccessExpression(callee) && starts.has(callee.name.text) &&
      ((ts.isIdentifier(callee.expression) && modules.has(callee.expression.text)) || isRequire(callee.expression))) name = callee.name.text;
    if (!name || node.arguments.some((argument) => /\bwindowsHide:\s*true\b/.test(argument.getText(source)))) return;
    hits.push({ file, line: location(source, node), name });
  });
  return hits;
}

export function checkHiddenStarts(files = trackedFiles(scanned), read = readSource) {
  const counts = new Map();
  const unhidden = files.flatMap((file) => hiddenStartHits(file, read(file)))
    .filter((hit) => {
      const entry = allowlist.find((entry) => entry.file === hit.file);
      if (!entry) return true;
      const count = (counts.get(hit.file) ?? 0) + 1;
      counts.set(hit.file, count);
      return count > entry.starts;
    })
    .map((hit) => `${hit.file}:${hit.line}: ${hit.name}() starts a process without windowsHide: true; a terminal window can open on Windows`);
  const stale = allowlist.filter((entry) => files.includes(entry.file) && (counts.get(entry.file) ?? 0) < entry.starts)
    .map((entry) => `${entry.file}: the allow-list permits ${entry.starts} unhidden starts but the file has ${counts.get(entry.file) ?? 0}; lower its count`);
  return [...unhidden, ...stale];
}

runCheck(import.meta.url, checkHiddenStarts);
