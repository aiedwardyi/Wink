import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
export const testFile = /\.(?:test|node-test)\.[cm]?[jt]sx?$/;

export function trackedFiles(pattern) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", windowsHide: true })
    .split("\0").filter((file) => pattern.test(file));
}

export function readSource(file) {
  return readFileSync(path.join(root, file), "utf8");
}

export function parseSource(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function location(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function runCheck(url, check) {
  if (!process.argv[1] || pathToFileURL(process.argv[1]).href !== url) return;
  try {
    const hits = check();
    for (const hit of hits) console.error(hit);
    if (hits.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
