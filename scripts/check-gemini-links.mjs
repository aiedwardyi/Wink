import ts from "typescript";
import { location, parseSource, readSource, runCheck, testFile, trackedFiles, walk } from "./repo-check.mjs";

// A link from Wink's folder into ~/.gemini lets a recursive remove, a copy or a helper's agy write reach the user's real one.
const sources = /^(?:server|electron|shared|companion\/src)\/.*\.[cm]?[jt]sx?$/;
const fsModule = /^(?:node:)?fs(?:\/promises)?$/;
const linkCalls = new Set(["symlink", "symlinkSync", "link", "linkSync"]);

const rootName = (node) => {
  while (ts.isPropertyAccessExpression(node)) node = node.expression;
  return ts.isIdentifier(node) ? node.text : undefined;
};

export function geminiLinkHits(file, text) {
  if (!/\.gemini|antigravity/i.test(text)) return [];
  const source = parseSource(file, text);
  const named = new Set();
  const modules = new Set();
  walk(source, (node) => {
    if (!ts.isImportDeclaration(node) || !fsModule.test(node.moduleSpecifier.text) || !node.importClause) return;
    const { name, namedBindings } = node.importClause;
    if (name) modules.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) modules.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const item of namedBindings.elements) if (linkCalls.has((item.propertyName ?? item.name).text)) named.add(item.name.text);
    }
  });
  const hits = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const direct = ts.isIdentifier(callee) && named.has(callee.text);
    const member = ts.isPropertyAccessExpression(callee) && linkCalls.has(callee.name.text) && modules.has(rootName(callee.expression));
    if (direct || member) hits.push({ file, line: location(source, node) });
  });
  return hits;
}

export function checkGeminiLinks(files = trackedFiles(sources).filter((file) => !testFile.test(file)), read = readSource) {
  return files.flatMap((file) => geminiLinkHits(file, read(file))).map((hit) =>
    `${hit.file}:${hit.line}: link created in code that handles the Gemini home; never link Wink's folder to ~/.gemini, give agy a home of its own files (server/drivers/antigravity-home.ts)`);
}

runCheck(import.meta.url, checkGeminiLinks);
