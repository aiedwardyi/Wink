import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// label, pattern, files allowed to match
const BANNED: Array<[string, RegExp, string[]]> = [
  ["download link", /\.download\s*=/g, []],
  ["desktop open call", /ogb\??\.(?:openFile|saveFile|openPeerFile)\??\.?\(/g, []],
  ["desktop open call", /\bconst \w+ = [^;\n]*ogb\??\.(?:openFile|saveFile|openPeerFile)\b/g, []],
  // The Show tab brings back the file the rule already showed.
  ["pane open", /\bshowItem\(/g, ["ShowPane.tsx"]],
];

/** Lines with a download attribute on a plain element; a pattern loses the tag at the `>` of an arrow function. */
function downloadAttributes(name: string, source: string): number[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "download" && /^[a-z]/.test(node.parent.parent.tagName.getText(file))) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

function offenders(name: string, source: string): string[] {
  const found = downloadAttributes(name, source).map((line) => `${name}:${line} download link`);
  for (const [label, pattern, allowed] of BANNED) {
    if (allowed.includes(name)) continue;
    for (const match of source.matchAll(pattern)) found.push(`${name}:${source.slice(0, match.index).split("\n").length} ${label}`);
  }
  return found;
}

const components = readdirSync(here, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".tsx") && !/\.test\.tsx?$/.test(name));

it("catches a download attribute after an arrow function, as well as a plain one", () => {
  expect(offenders("Save.tsx", "<a href={src} onClick={() => {}} download={name}>Save</a>")).toEqual(["Save.tsx:1 download link"]);
  expect(offenders("Save.tsx", "<a href={src} download={name}>Save</a>")).toEqual(["Save.tsx:1 download link"]);
});

it("opens, shows and downloads files only through @/lib/open-file", () => {
  const found = components.flatMap((name) => offenders(name, readFileSync(join(here, name), "utf8")));
  expect(found, "Open, show or download a file with openFile or saveFile from @/lib/open-file, so a tap does the same thing on every surface").toEqual([]);
});
