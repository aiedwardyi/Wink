import { expect, it } from "vitest";
import { mapSquares, squareTarget } from "./map-squares";

const repo = [
  "README.md", "package.json",
  "src/App.tsx", "src/main.tsx",
  "src/components/A.tsx", "src/components/B.tsx", "src/components/C.tsx",
  "src/lib/x.ts", "src/lib/y.ts", "src/state/s.ts", "src/types/t.ts",
  "server/a.ts", "server/b.ts", "server/c.ts", "server/d.ts",
  "electron/main.mjs", "electron/host.mjs", "electron/bridge.mjs",
  "docs/a.md", "docs/b.md", "scripts/run.mjs", "tools/x.mjs",
];

it("groups the changed top folder by subfolder and folds quiet ones together", () => {
  const map = mapSquares(repo, ["src/components/B.tsx", "src/App.tsx"]);
  expect(map.total).toBe(22);
  expect(map.near.map(group => [group.key, group.count])).toEqual([["src", 9]]);
  expect(map.near[0].subs?.map(sub => [sub.key, sub.name, sub.count, sub.lit])).toEqual([
    ["src", "", 2, [0]],
    ["src/components", "components", 3, [1]],
    ["src/*", "lib, state, types", 4, []],
  ]);
  expect(map.near[0].subs?.[2].quiet).toBe(true);
  expect(map.near[0].subs?.[1].cells).toEqual(["src/components/A.tsx", "src/components/B.tsx", "src/components/C.tsx"]);
});

it("lists untouched folders by size and folds the rest into one group", () => {
  const map = mapSquares(repo, ["src/App.tsx"]);
  expect(map.far.map(group => [group.key, group.count, group.more])).toEqual([
    ["server", 4, undefined], ["electron", 3, undefined], ["", 2, undefined], ["*", 4, 3],
  ]);
  expect(map.far[3].cells).toEqual(["docs/a.md", "docs/b.md", "scripts/run.mjs", "tools/x.mjs"]);
  expect(map.far.every(group => !group.lit.length)).toBe(true);
});

it("adds a new file git has not listed yet and lights root files", () => {
  const map = mapSquares(repo, ["src/lib/new.ts", "README.md"]);
  expect(map.total).toBe(23);
  expect(map.near.map(group => [group.key, group.count, group.lit])).toEqual([["src", 10, []], ["", 2, [0]]]);
  const lib = map.near[0].subs!.find(sub => sub.key === "src/lib")!;
  expect(lib.cells).toEqual(["src/lib/new.ts", "src/lib/x.ts", "src/lib/y.ts"]);
  expect(lib.lit).toEqual([0]);
});

it("finds the pointer's square and shows every folder far when nothing changed", () => {
  const map = mapSquares(repo, ["src/components/C.tsx"]);
  expect(squareTarget(map, "src/components/C.tsx")).toEqual({ group: "src/components", index: 2 });
  expect(squareTarget(map, "src/lib/x.ts")).toBeNull();
  expect(squareTarget(map, undefined)).toBeNull();
  const quiet = mapSquares(repo, []);
  expect(quiet.near).toEqual([]);
  expect(quiet.far.map(group => group.key)).toEqual(["src", "server", "electron", "*"]);
});

it("builds a 2,600-file map quickly", () => {
  const paths = Array.from({ length: 2_600 }, (_, index) => `${["src", "server", "electron", "shared"][index % 4]}/d${index % 23}/f${index}.ts`);
  const started = performance.now();
  const map = mapSquares(paths, paths.filter((_, index) => index % 300 === 0));
  expect(performance.now() - started).toBeLessThan(50);
  expect(map.total).toBe(2_600);
});
