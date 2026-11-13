import type { MapWorker } from "../../shared/map-pane";

export interface TreeDir {
  path: string;
  name: string;
  parent?: TreeDir;
  subs: TreeDir[];
  files: string[];
  total: number;
}

export interface TreeIndex {
  root: TreeDir;
  dirs: Map<string, TreeDir>;
  size: number;
}

export type TreeFont = "root" | "dir" | "count" | "file";

export interface TreeItem {
  id: string;
  kind: "root" | "dir" | "col" | "box" | "stack" | "more";
  parent?: TreeItem;
  kids?: TreeItem[];
  dir?: TreeDir;
  files?: string[];
  squares?: string[];
  hidden?: number;
  per?: number;
  squaresHeight?: number;
  dirs?: number;
  count?: number;
  filesOnly?: boolean;
  changed?: boolean;
  label?: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bw: number;
}

export interface TreeOptions {
  width: number;
  phone: boolean;
  changed: ReadonlySet<string>;
  current?: string;
  team?: { named: ReadonlySet<string>; marks: ReadonlySet<string>; rank(path: string): number };
  measure(text: string, font: TreeFont): number;
  folders(n: number): string;
  files(n: number): string;
}

export interface Point { x: number; y: number }

export const TREE = { BOX: 26, VGAP: 22, LINE: 17, SGAP: 7, GAP: 10, SMALL: 40, SQ: 9 };
const { BOX, VGAP, LINE, SGAP, GAP, SMALL, SQ } = TREE;
const byPath = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const dirOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const fmt = (n: number) => n.toLocaleString("en-US");

export function treeIndex(name: string, paths: Iterable<string>): TreeIndex {
  const root: TreeDir = { path: "", name, subs: [], files: [], total: 0 };
  const dirs = new Map([["", root]]);
  for (const path of paths) {
    let dir = root;
    for (let at = 0, slash = path.indexOf("/"); slash >= 0; at = slash + 1, slash = path.indexOf("/", at)) {
      const key = path.slice(0, slash);
      let next = dirs.get(key);
      if (!next) { next = { path: key, name: path.slice(at, slash), parent: dir, subs: [], files: [], total: 0 }; dirs.set(key, next); dir.subs.push(next); }
      dir = next;
    }
    dir.files.push(path);
    for (let up: TreeDir | undefined = dir; up; up = up.parent) up.total++;
  }
  for (const dir of dirs.values()) { dir.subs.sort((a, b) => b.total - a.total || byPath(a.name, b.name)); dir.files.sort(byPath); }
  return { root, dirs, size: root.total };
}

export function treeOrder(index: TreeIndex, changed: ReadonlySet<string>): string[] {
  const order: string[] = [];
  const walk = (dir: TreeDir) => {
    for (const sub of dir.subs) walk(sub);
    for (const file of dir.files) if (changed.has(file)) order.push(file);
  };
  walk(index.root);
  return order;
}

function build(index: TreeIndex, o: TreeOptions) {
  const small = index.size <= SMALL;
  const visible = small ? null : o.changed;
  const open = new Set([""]);
  const lit = new Set<string>();
  for (const path of o.changed) for (let dir = dirOf(path); dir && !lit.has(dir); dir = dirOf(dir)) lit.add(dir);
  if (visible) for (const dir of lit) open.add(dir);
  else for (const dir of index.dirs.keys()) open.add(dir);
  const deep = (dir: TreeDir) => dir.subs.some(sub => open.has(sub.path));
  const stack = (dir: TreeDir): Pick<TreeItem, "files" | "squares" | "hidden"> | null => {
    if (o.team) {
      const files = dir.files.filter(file => o.changed.has(file));
      if (!files.length) return null;
      return { files: files.filter(file => o.team!.named.has(file)), squares: files.toSorted((a, b) => o.team!.rank(a) - o.team!.rank(b) || byPath(a, b)), hidden: 0 };
    }
    const files = visible ? dir.files.filter(file => visible.has(file)) : dir.files;
    if (!files.length) return null;
    return { files, hidden: dir.files.length - files.length };
  };
  const focus = o.phone && !small ? o.current : undefined;
  const onPath = (path: string) => !focus || focus.startsWith(path + "/");
  const item = (value: Omit<TreeItem, "x" | "y" | "w" | "h" | "bw">): TreeItem => ({ x: 0, y: 0, w: 0, h: 0, bw: 0, ...value });
  const rows: TreeItem[][] = [[item({ kind: "root", id: "d:", dir: index.root })]];
  for (let r = 0; r < rows.length; r++) {
    const next: TreeItem[] = [];
    for (const it of rows[r]) {
      if (it.kind !== "root" && it.kind !== "dir") continue;
      const dir = it.dir!;
      const kids: TreeItem[] = [];
      const shut = dir.subs.filter(sub => !open.has(sub.path));
      for (const sub of dir.subs) {
        if (!open.has(sub.path)) continue;
        if (!onPath(sub.path)) kids.push(item({ kind: "box", id: "d:" + sub.path, dir: sub, parent: it }));
        else if (deep(sub)) kids.push(item({ kind: "dir", id: "d:" + sub.path, dir: sub, parent: it }));
        else kids.push(item({ kind: "col", id: "d:" + sub.path, dir: sub, parent: it, ...stack(sub) ?? { files: [], hidden: sub.files.length } }));
      }
      let own = stack(dir);
      if (own && focus && dirOf(focus) !== dir.path) {
        kids.push(item({ kind: "more", id: "f:" + dir.path, dirs: 0, count: dir.files.length, parent: it, filesOnly: true, changed: dir.files.some(file => o.changed.has(file)) }));
        own = null;
      }
      const loose = own || kids.some(kid => kid.id === "f:" + dir.path) ? 0 : dir.files.length;
      if (own) kids.push(item({ kind: "stack", id: "s:" + dir.path, dir, parent: it, ...own }));
      if (it.kind === "root" && !small) {
        for (const sub of shut) kids.push(item({ kind: "box", id: "d:" + sub.path, dir: sub, parent: it }));
        if (loose) kids.push(item({ kind: "more", id: "f:", dirs: 0, count: loose, parent: it, filesOnly: true }));
      } else if (shut.length || loose) kids.push(item({ kind: "more", id: "m:" + dir.path, dirs: shut.length, count: shut.reduce((sum, sub) => sum + sub.total, 0) + loose, parent: it, changed: shut.some(sub => lit.has(sub.path)) }));
      it.kids = kids;
      next.push(...kids);
    }
    if (next.length) rows.push(next);
  }
  return { rows, small, lit };
}

function measure(it: TreeItem, o: TreeOptions, maxStack: number) {
  if (it.dir && it.kind !== "stack") {
    const label = it.kind === "root" ? it.dir.name : it.dir.name + "/";
    it.bw = Math.ceil(o.measure(label, it.kind === "root" ? "root" : "dir") + o.measure(fmt(it.dir.total), "count") + 24);
    if (it.kind !== "col") { it.w = it.bw; it.h = BOX; return; }
    const [w, h] = measureStack(it, o, maxStack);
    it.w = Math.max(it.bw, w); it.h = BOX + SGAP + h;
  } else if (it.kind === "stack") [it.w, it.h] = measureStack(it, o, maxStack);
  else {
    const files = it.filesOnly || !it.dirs;
    it.label = files ? o.files(it.count!) : o.folders(it.dirs!);
    it.sub = files || o.phone ? "" : fmt(it.count!);
    it.w = it.bw = Math.ceil(o.measure(it.label, "dir") + (it.sub ? o.measure(it.sub, "count") + 6 : 0) + 18); it.h = BOX;
  }
}

function measureStack(it: TreeItem, o: TreeOptions, maxStack: number): [number, number] {
  let w = 0;
  for (const file of it.files!) w = Math.max(w, o.measure(file.slice(file.lastIndexOf("/") + 1), "file") + (o.team?.marks.has(file) ? 26 : 0));
  if (it.hidden) w = Math.max(w, o.measure(o.files(it.hidden), "count"));
  if (it.squares) {
    w = Math.max(w, Math.min(it.squares.length, 10) * SQ - 2);
    const sw = Math.min(maxStack, Math.ceil(w + 36));
    it.per = Math.max(4, Math.min(it.squares.length, Math.floor((sw - 22) / SQ)));
    it.squaresHeight = Math.ceil(it.squares.length / it.per) * SQ + 2;
    return [sw, it.squaresHeight + it.files!.length * LINE + 4];
  }
  return [Math.min(maxStack, Math.ceil(w + 36)), it.files!.length * LINE + (it.hidden ? LINE - 2 : 0) + 4];
}

export function treeLayout(index: TreeIndex, o: TreeOptions) {
  const { rows, small, lit } = build(index, o);
  const W = o.width;
  let maxStack = o.phone ? 160 : 230;
  const width = (row: TreeItem[]) => row.reduce((sum, it) => sum + it.w, 0) + GAP * (row.length - 1);
  const items: TreeItem[] = [];
  let y = 0;
  rows.forEach((row, r) => {
    for (const it of row) measure(it, o, maxStack);
    // A big repo's top row folds its smallest closed folders into one "+N folders" box until it fits.
    if (r === 1 && !small) {
      const parent = rows[0][0];
      while (width(row) > W) {
        const last = row.findLast(it => it.kind === "box");
        if (!last) break;
        row.splice(row.indexOf(last), 1);
        let more = row.find(it => it.id === "m:");
        if (!more) {
          more = { kind: "more", id: "m:", dirs: 0, count: 0, parent, x: 0, y: 0, w: 0, h: 0, bw: 0 };
          const at = row.findIndex(it => it.filesOnly);
          row.splice(at < 0 ? row.length : at, 0, more);
        }
        more.dirs!++; more.count! += last.dir!.total;
        const loose = row.find(it => it.id === "f:");
        if (loose) { row.splice(row.indexOf(loose), 1); more.count! += loose.count!; }
        measure(more, o, maxStack);
      }
      if (o.team && width(row) > W) for (const id of ["m:", "f:"]) { const it = row.find(it => it.id === id); if (it && width(row) > W) row.splice(row.indexOf(it), 1); }
      parent.kids = row.filter(it => it.parent === parent);
    }
    const groups: { parent?: TreeItem; items: TreeItem[]; x: number; w: number }[] = [];
    for (const it of row) {
      const group = groups.at(-1);
      if (group && group.parent === it.parent) group.items.push(it); else groups.push({ parent: it.parent, items: [it], x: 0, w: 0 });
    }
    const span = () => { for (const group of groups) group.w = width(group.items); return groups.reduce((sum, group) => sum + group.w, 0) + GAP * 2 * (groups.length - 1); };
    for (let guard = 0; span() > W && guard < 14; guard++) { maxStack = Math.max(96, maxStack - 12); for (const it of row) measure(it, o, maxStack); }
    let end = -GAP * 2;
    for (const group of groups) {
      const center = group.parent ? group.parent.x + group.parent.bw / 2 : W / 2;
      group.x = Math.max(0, center - group.w / 2, end + GAP * 2); end = group.x + group.w;
    }
    let limit = W;
    for (const group of groups.toReversed()) { group.x = Math.max(0, Math.min(group.x, limit - group.w)); limit = group.x - GAP * 2; }
    let h = 0;
    for (const group of groups) {
      let x = group.x;
      for (const it of group.items) { it.x = Math.round(x); it.y = y; x += it.w + GAP; h = Math.max(h, it.h); items.push(it); }
    }
    y += h + VGAP;
  });
  return { items, height: y - VGAP + 2, lit };
}

const centerX = (it: TreeItem, at: Point) => at.x + it.bw / 2;
const stackTop = (it: TreeItem, at: Point) => it.kind === "col" ? at.y + BOX + SGAP : at.y;
export const rowY = (it: TreeItem, at: Point, index: number) => stackTop(it, at) + 2 + (it.squaresHeight ?? 0) + index * LINE + LINE / 2;
const topOf = (it: TreeItem, at: Point) => it.kind === "stack" ? { x: at.x + 7, y: at.y } : { x: centerX(it, at), y: at.y };
const half = (n: number) => Math.round(n) + 0.5;

export function treeEdges(items: readonly TreeItem[], at: (it: TreeItem) => Point) {
  let d = "";
  for (const parent of items) {
    if (!parent.kids?.length) continue;
    const p = at(parent);
    const bus = half(at(parent.kids[0]).y - VGAP / 2);
    const px = half(centerX(parent, p));
    const xs = parent.kids.map(kid => half(topOf(kid, at(kid)).x));
    d += `M${px} ${p.y + BOX}V${bus}M${Math.min(px, ...xs)} ${bus}H${Math.max(px, ...xs)}`;
    for (const kid of parent.kids) { const t = topOf(kid, at(kid)); d += `M${half(t.x)} ${bus}V${t.y}`; }
  }
  for (const it of items) {
    if (it.kind !== "col" && it.kind !== "stack") continue;
    const g = at(it);
    const sx = half(g.x + 7);
    const mids = it.files!.map((_, i) => rowY(it, g, i));
    if (it.squares) mids.unshift(stackTop(it, g) + 5.5);
    if (!mids.length) continue;
    d += `M${sx} ${it.kind === "col" ? g.y + BOX : g.y}V${half(mids.at(-1)!)}`;
    for (const y of mids) d += `M${sx} ${half(y)}H${sx + 6}`;
  }
  return d;
}

interface ClimbPoint extends Point { id: string; bus?: string; busOf?: string }

export function treeClimb(items: readonly TreeItem[], path: string, at: (it: TreeItem) => Point): ClimbPoint[] | null {
  const it = items.find(it => it.files?.includes(path));
  if (!it) return null;
  const g = at(it);
  const sx = g.x + 7;
  const ry = rowY(it, g, it.files!.indexOf(path));
  const points: ClimbPoint[] = [{ x: sx + 7, y: ry, id: "row" }, { x: sx, y: ry, id: it.id }];
  if (it.kind === "col") points.push({ x: sx, y: g.y + BOX, id: it.id }, { x: centerX(it, g), y: g.y, id: it.id });
  else points.push({ x: sx, y: g.y, id: it.id });
  for (let node = it; node.parent; node = node.parent) {
    const parent = node.parent;
    const pg = at(parent);
    const bus = at(parent.kids?.[0] ?? node).y - VGAP / 2;
    points.push({ x: topOf(node, at(node)).x, y: bus, id: node.id, bus: parent.id }, { x: centerX(parent, pg), y: bus, id: parent.id, busOf: parent.id },
      { x: centerX(parent, pg), y: pg.y + BOX, id: parent.id }, { x: centerX(parent, pg), y: pg.y, id: parent.id });
  }
  return points;
}

export function treeRoute(items: readonly TreeItem[], from: string, to: string, at: (it: TreeItem) => Point): Point[] | null {
  const a = treeClimb(items, from, at);
  const b = treeClimb(items, to, at);
  if (!a || !b) return null;
  if (a[1].id === b[1].id) return [a[0], a[1], b[1], b[0]];
  const buses = new Set(b.map(point => point.busOf).filter(Boolean));
  const common = a.map(point => point.busOf).find(id => id && buses.has(id));
  if (!common) return [a[0], b[0]];
  const cut = (points: ClimbPoint[]) => points.slice(0, points.findIndex(point => point.bus === common) + 1);
  return [...cut(a), ...cut(b).reverse()];
}

export function treeAlong(points: readonly Point[], k: number): Point {
  const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y));
  let left = k * lengths.reduce((sum, length) => sum + length, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? Math.min(1, Math.max(0, left / lengths[i])) : 1;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f };
    }
    left -= lengths[i];
  }
  return points.at(-1)!;
}

export interface MapClash { path: string; a: string; b: string; same: boolean }

// Ranges within 3 lines count as the same lines: that is where a merge stops for a person.
const near = (a: readonly [number, number][], b: readonly [number, number][]) => a.some(([s, e]) => b.some(([t, u]) => s <= u + 3 && t <= e + 3));

export function mapClashes(workers: readonly MapWorker[]): MapClash[] {
  const owners = new Map<string, { id: string; ranges?: [number, number][] }[]>();
  for (const worker of workers) for (const file of worker.files) {
    const list = owners.get(file.path);
    if (list) list.push({ id: worker.id, ranges: file.ranges }); else owners.set(file.path, [{ id: worker.id, ranges: file.ranges }]);
  }
  const clashes: MapClash[] = [];
  for (const [path, list] of owners) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const [a, b] = [list[i], list[j]];
    clashes.push({ path, a: a.id, b: b.id, same: !!a.ranges && !!b.ranges && near(a.ranges, b.ranges) });
  }
  return clashes.sort((x, y) => Number(y.same) - Number(x.same) || byPath(x.path, y.path));
}
