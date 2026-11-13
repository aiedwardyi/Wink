import { expect, it } from "vitest";
import { treeIndex, treeLayout } from "./map-tree";

it("keeps boxes in a row apart when every worker's branches cannot fit side by side", () => {
  const tops = ["src", "packages", "server", "tests", "docs", "assets"];
  const paths = tops.flatMap(top => ["components", "lib", "routes", "store", "unit"].flatMap(sub => Array.from({ length: 30 }, (_, i) => `${top}/${sub}/file-${i}.ts`)));
  const changed = new Set(tops.flatMap(top => [`${top}/components/file-1.ts`, `${top}/lib/file-2.ts`, `${top}/routes/file-3.ts`]));
  const team = { named: new Set(["src/lib/file-2.ts"]), marks: new Set<string>(), rank: () => 0 };
  const { items } = treeLayout(treeIndex("repo", paths), { width: 600, phone: false, changed, current: "src/lib/file-2.ts", team, measure: text => text.length * 7, folders: n => `+${n} folders`, files: n => `+${n} files` });
  for (const y of new Set(items.map(it => it.y))) {
    const row = items.filter(it => it.y === y);
    const spans = row.map(it => [it.x, it.x + it.w]).sort((a, b) => a[0] - b[0]);
    expect(spans[0][0]).toBeGreaterThanOrEqual(0);
    expect(spans.at(-1)![1]).toBeLessThanOrEqual(600);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
  }
  expect(items.some(it => it.files?.includes("src/lib/file-2.ts"))).toBe(true);
});

it("folds sibling folders that cannot fit even after shrinking into a folders box inside the view", () => {
  const paths = Array.from({ length: 8 }, (_, i) => `folder-${i}/file.ts`);
  const changed = new Set(paths);
  for (const current of [undefined, "folder-5/file.ts"]) {
    const { items } = treeLayout(treeIndex("repo", paths), { width: 560, phone: false, changed, current, measure: text => text.length * 7, folders: n => `+${n} folders`, files: n => `+${n} files` });
    for (const it of items) {
      expect(it.x).toBeGreaterThanOrEqual(0);
      expect(it.x + it.w).toBeLessThanOrEqual(560);
    }
    const folded = (path: string) => items.some(it => it.kind === "more" && it.changed && path.startsWith(it.parent!.dir!.path));
    for (const path of paths) expect(items.some(it => it.files?.includes(path)) || folded(path)).toBe(true);
    if (current) expect(items.some(it => it.files?.includes(current))).toBe(true);
  }
});
