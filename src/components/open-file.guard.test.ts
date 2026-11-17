import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// label, pattern, files allowed to match
const BANNED: Array<[string, RegExp, string[]]> = [
  ["download link", /<[a-z]+\b[^<>]*?\sdownload(?:=|[\s/>])/g, []],
  ["download link", /\.download\s*=/g, []],
  ["desktop open call", /ogb\??\.(?:openFile|saveFile|openPeerFile)\??\.?\(/g, []],
  ["desktop open call", /\bconst \w+ = [^;\n]*ogb\??\.(?:openFile|saveFile|openPeerFile)\b/g, []],
  // The Show tab brings back the file the rule already showed.
  ["pane open", /\bshowItem\(/g, ["ShowPane.tsx"]],
];

const components = readdirSync(here, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".tsx") && !/\.test\.tsx?$/.test(name));

it("opens, shows and downloads files only through @/lib/open-file", () => {
  const found: string[] = [];
  for (const name of components) {
    const source = readFileSync(join(here, name), "utf8");
    for (const [label, pattern, allowed] of BANNED) {
      if (allowed.includes(name)) continue;
      for (const match of source.matchAll(pattern)) found.push(`${name}:${source.slice(0, match.index).split("\n").length} ${label}`);
    }
  }
  expect(found, "Open, show or download a file with openFile or saveFile from @/lib/open-file, so a tap does the same thing on every surface").toEqual([]);
});
