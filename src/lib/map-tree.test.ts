import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { MapWorker } from "../../shared/map-pane";
import { fmt, mapClashes, treeIndex, treeLayout } from "./map-tree";

it("sizes a folder box for the padding, border and gap its name and count are drawn with", () => {
  const box = readFileSync("src/components/MapTree.css", "utf8").match(/\.map-tree-box \{([^}]*)\}/)![1];
  const px = (rule: RegExp) => Number(box.match(rule)![1]);
  const around = 2 * px(/ padding: 0 (\d+)px;/) + 2 * px(/ border: (\d+)px /) + px(/ gap: (\d+)px;/);
  expect(around).toBe(28);
  const paths = ["README.md", "src/index.ts", "src/lib/util.ts", "integration-fixtures/a.ts", ...Array.from({ length: 1111 }, (_, i) => `docs/page-${i}.md`)];
  const { items } = treeLayout(treeIndex("repo", paths), { width: 900, phone: false, changed: new Set(["src/lib/util.ts"]), measure: text => text.length * 7, folders: n => `+${n} folders`, files: n => `+${n} files` });
  const boxes = items.filter(it => it.dir && it.kind !== "stack");
  expect(boxes.map(it => [it.kind, it.dir!.name, fmt(it.dir!.total)])).toEqual([["root", "repo", "1,115"], ["dir", "src", "2"], ["box", "docs", "1,111"], ["box", "integration-fixtures", "1"], ["col", "lib", "1"]]);
  for (const it of boxes) expect(it.bw - ((it.kind === "root" ? 0 : 1) + it.dir!.name.length + fmt(it.dir!.total).length) * 7).toBe(around);
});

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

const opts = (width: number, changed: Set<string>, extra: Partial<Parameters<typeof treeLayout>[1]> = {}, px = 7) =>
  ({ width, phone: true, changed, measure: (text: string) => text.length * px, folders: (n: number) => `+${n} folders`, files: (n: number) => `+${n} files`, ...extra });
const overlaps = (items: ReturnType<typeof treeLayout>["items"]) => {
  let count = 0;
  for (const y of new Set(items.map(it => it.y))) {
    const spans = items.filter(it => it.y === y).map(it => [it.x, it.x + it.w]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) count++;
  }
  return count;
};

it("keeps every box of a small project apart on a phone", () => {
  const paths = ["package.json", "README.md", "src/index.ts", "src/components/App.tsx", "src/components/Button.tsx", "src/lib/util.ts", "server/index.ts", "server/routes/api.ts", "docs/guide.md", "docs/img/shot.png"];
  for (const width of [366, 342]) for (const px of [6, 7]) for (const current of [undefined, "src/lib/util.ts"]) {
    const changed = new Set(current ? [current] : []);
    const { items } = treeLayout(treeIndex("repo", paths), opts(width, changed, { current }, px));
    expect(overlaps(items)).toBe(0);
    if (current) expect(items.some(it => it.files?.includes(current))).toBe(true);
  }
});

it("keeps every box apart across random small projects on a phone", () => {
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * n); };
  const dirs = ["src", "lib", "components", "server", "routes", "docs", "img", "tests", "utils", "api", "shared", "public", "scripts", "hooks", "styles"];
  const names = ["index.ts", "App.tsx", "util.ts", "README.md", "package.json", "guide.md", "shot.png", "api.ts", "main.css", "config.json"];
  let bad = 0;
  for (let run = 0; run < 2000; run++) {
    const paths = new Set<string>();
    for (let n = 1 + rand(40); n--;) paths.add([...Array.from({ length: rand(4) }, () => dirs[rand(dirs.length)]), names[rand(names.length)]].join("/"));
    const list = [...paths];
    const changed = new Set(Array.from({ length: rand(4) }, () => list[rand(list.length)]));
    const current = changed.size && rand(3) ? [...changed][rand(changed.size)] : undefined;
    const team = changed.size && !rand(3) ? { named: new Set(current ? [current] : []), marks: new Set<string>(), rank: () => 0 } : undefined;
    const { items } = treeLayout(treeIndex("repo", list), opts(rand(2) ? 366 : 342, changed, { current, team }, 6 + rand(2)));
    if (overlaps(items)) bad++;
  }
  expect(bad).toBe(0);
});

it("keeps a changed root file reachable when the phone's top row folds it away", () => {
  const dirs: [string, number][] = [["src/lib", 14], ["src/components", 14], ["server", 12], ["shared", 5], ["docs", 4], ["scripts", 3], ["electron", 3], ["tests", 3], ["public", 2]];
  const paths = ["package.json", "README.md", "tsconfig.json", "LICENSE", ...dirs.flatMap(([dir, n]) => Array.from({ length: n }, (_, i) => `${dir}/file-${i}.ts`))];
  expect(paths).toHaveLength(64);
  const current = "src/lib/file-3.ts";
  const changed = new Set(["package.json", current]);
  for (const team of [undefined, { named: new Set([current]), marks: new Set<string>(), rank: () => 0 }]) {
    const { items } = treeLayout(treeIndex("repo", paths), opts(366, changed, { current, team }));
    const shown = items.some(it => (it.squares ?? it.files)?.includes("package.json"));
    const held = items.some(it => it.kind === "more" && it.changed && it.filesOf === "");
    expect(shown || held).toBe(true);
  }
});

it("lists a file many workers share as one clash", () => {
  const workers: MapWorker[] = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, nick: `W${i}`, git: true, editedAt: i, files: [{ path: "src/lib/i18n-catalog.ts", added: 1, removed: 0, ranges: [[i * 100, i * 100 + 1]] }] }));
  workers[9].files[0].ranges = [[1, 2]];
  expect(mapClashes(workers)).toEqual([{ path: "src/lib/i18n-catalog.ts", ids: workers.map(worker => worker.id), same: true }]);
  expect(mapClashes(workers.slice(1, 9))).toEqual([{ path: "src/lib/i18n-catalog.ts", ids: workers.slice(1, 9).map(worker => worker.id), same: false }]);
});
