import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { MapWorker } from "../../shared/map-pane";
import { fmt, mapClashes, rowY, TREE, treeClimb, treeEdges, treeIndex, treeLayout } from "./map-tree";

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

it("runs a parent's line straight into a kid that sits under it, at every width", () => {
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * n); };
  const tops = ["src", "server", ".github", "supabase", "services", "docs", "lib", "app", "tests", "scripts", "public", "ios", "assets", "electron", "shared"];
  const jags: string[] = [];
  for (let run = 0; run < 40; run++) {
    const paths = tops.filter(() => rand(5) < 2).flatMap(top => Array.from({ length: 1 + rand(40) }, (_, i) => `${top}/${rand(2) ? "sub/" : ""}file-${i}.ts`));
    const changed = new Set(paths.filter(() => !rand(20)));
    const px = 5.5 + rand(20) / 10;
    for (let width = 320; width <= 1000; width += 7) {
      const { items } = treeLayout(treeIndex("zlife-audit-fixes", paths), opts(width, changed, { phone: width < 480 }, px));
      for (const parent of items.filter(it => it.kids?.length)) {
        const legs = treeEdges([parent], it => it).split("M").filter(Boolean).map(leg => ({ straight: leg.includes("V"), at: leg.match(/[\d.]+/g)!.map(Number) }));
        const [x, y] = legs[0].at;
        for (const { straight, at } of legs) {
          const kid = straight ? at[0] : at.at(-2)!;
          if (at[0] === x && at[1] === y && kid !== x && Math.abs(kid - x) <= 4) jags.push(`run ${run} width ${width} ${parent.id}: ${x} -> ${kid}`);
        }
      }
      for (const path of changed) {
        const climb = treeClimb(items, path, it => it) ?? [];
        climb.forEach((point, i) => { const off = point.busOf ? Math.abs(Math.round(point.x) - Math.round(climb[i - 1].x)) : 0; if (off && off <= 4) jags.push(`run ${run} width ${width} ${path}: lit line ${off}px`); });
      }
    }
  }
  expect(jags).toEqual([]);
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

it("spaces a stack's file rows by the given pitch, so a phone can give each a finger's height", () => {
  const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const stack = (line?: number) => treeLayout(treeIndex("repo", paths), { width: 600, phone: false, line, changed: new Set(paths), measure: text => text.length * 7, folders: n => `+${n} folders`, files: n => `+${n} files` }).items.find(it => it.files)!;
  const [mouse, finger] = [stack(), stack(44)];
  expect(rowY(mouse, mouse, 1) - rowY(mouse, mouse, 0)).toBe(17);
  expect(rowY(finger, finger, 1) - rowY(finger, finger, 0)).toBe(44);
  expect(finger.h - mouse.h).toBe(3 * (44 - 17));
});

it("sizes a +N folders box for the padding, border and gap its label and count are drawn with", () => {
  const box = readFileSync("src/components/MapTree.css", "utf8").match(/\.map-tree-box \{([^}]*)\}/)![1];
  const px = (rule: RegExp) => Number(box.match(rule)![1]);
  const edge = 2 * px(/ padding: 0 (\d+)px;/) + 2 * px(/ border: (\d+)px /);
  const gap = px(/ gap: (\d+)px;/);
  const paths = ["README.md", "src/index.ts", "src/lib/util.ts", ...Array.from({ length: 1111 }, (_, i) => `docs/page-${i}.md`), ...Array.from({ length: 50 }, (_, i) => `assets/img-${i}.png`)];
  const { items } = treeLayout(treeIndex("repo", paths), { width: 120, phone: false, changed: new Set(["src/lib/util.ts"]), measure: text => text.length * 7, folders: n => `+${n} folders`, files: n => `+${n} files` });
  const more = items.filter(it => it.kind === "more");
  expect(more.length).toBeGreaterThan(0);
  for (const it of more) expect(it.bw).toBe(it.label!.length * 7 + (it.sub ? it.sub.length * 7 + gap : 0) + edge);
});

it("keeps every row inside the tree and its boxes and file squares apart when nothing else can fold", () => {
  const tops = ["src", "packages", "server", "tests", "docs", "assets", "public", "scripts"];
  const paths = tops.flatMap(top => ["components", "lib", "routes", "store", "unit"].flatMap(sub => Array.from({ length: 30 }, (_, i) => `${top}/${sub}/file-${i}.ts`))).concat(tops.map(top => `${top}/index.ts`));
  const changed = new Set(tops.flatMap(top => [`${top}/components/file-1.ts`, `${top}/lib/file-2.ts`, `${top}/index.ts`]));
  const team = { named: new Set<string>(), marks: new Set<string>(), rank: () => 0 };
  for (const width of [600, 900, 1200]) for (const phone of [false, true]) {
    const { items } = treeLayout(treeIndex("repo", paths), { width, phone, changed, team, measure: text => text.length * 7, folders: n => `+${n} folders`, files: n => `+${n} files` });
    for (const y of new Set(items.map(it => it.y))) {
      const row = items.filter(it => it.y === y).toSorted((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) expect(row[i].x, `${width} ${phone} ${row[i - 1].id} / ${row[i].id}`).toBeGreaterThanOrEqual(row[i - 1].x + row[i - 1].w);
      expect(row[0].x).toBeGreaterThanOrEqual(0);
      for (const it of row) if (it.squares) expect(14 + it.per! * TREE.SQ, `${width} ${phone} ${it.id} squares`).toBeLessThanOrEqual(it.w);
      expect(row.at(-1)!.x + row.at(-1)!.w, `${width} ${phone} right edge`).toBeLessThanOrEqual(width);
    }
  }
});

it("keeps a stack wide enough for its hidden-files label when the row narrows", () => {
  const paths = ["a/x/file.ts", "b/x/file.ts", "a/file.ts", "b/file.ts", ...["a", "b"].flatMap(top => Array.from({ length: 9999 }, (_, i) => `${top}/other-${i}.ts`))];
  const changed = new Set(paths.slice(0, 4));
  const measure = (text: string) => text.length * 7;
  for (const width of [342, 300, 260]) {
    const { items } = treeLayout(treeIndex("repo", paths), { width, phone: false, changed, measure, folders: n => `+${n} folders`, files: n => `+${fmt(n)} files` });
    const stacks = items.filter(it => it.hidden);
    expect(stacks.length).toBeGreaterThan(0);
    for (const it of stacks) expect(14 + measure(`+${fmt(it.hidden!)} files`), `${width} ${it.id} label`).toBeLessThanOrEqual(it.w);
    for (const y of new Set(items.map(it => it.y))) {
      const row = items.filter(it => it.y === y).toSorted((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) expect(row[i].x, `${width} ${row[i - 1].id} / ${row[i].id}`).toBeGreaterThanOrEqual(row[i - 1].x + row[i - 1].w);
      expect(row.at(-1)!.x + row.at(-1)!.w, `${width} right edge`).toBeLessThanOrEqual(width);
    }
  }
});
