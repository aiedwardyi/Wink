export interface SquareGroup {
  key: string;
  name: string;
  count: number;
  cells: string[];
  lit: number[];
  subs?: SquareGroup[];
  quiet?: boolean;
  more?: number;
}

export interface SquareMap {
  total: number;
  near: SquareGroup[];
  far: SquareGroup[];
}

const FAR = 3;
const top = (path: string) => path.includes("/") ? path.slice(0, path.indexOf("/")) : "";
const byPath = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function group(key: string, name: string, cells: string[], changed: ReadonlySet<string>): SquareGroup {
  const lit: number[] = [];
  cells.forEach((path, index) => { if (changed.has(path)) lit.push(index); });
  return { key, name, count: cells.length, cells, lit };
}

function nearGroup(key: string, cells: string[], changed: ReadonlySet<string>): SquareGroup {
  if (!key) return group(key, "", cells, changed);
  const folders = new Map<string, string[]>();
  for (const path of cells) {
    const rest = path.slice(key.length + 1);
    const sub = rest.includes("/") ? `${key}/${rest.slice(0, rest.indexOf("/"))}` : key;
    const list = folders.get(sub);
    if (list) list.push(path); else folders.set(sub, [path]);
  }
  const subs: SquareGroup[] = [];
  const quiet: [string, string[]][] = [];
  for (const [sub, paths] of [...folders].sort(([a], [b]) => a === key ? -1 : b === key ? 1 : byPath(a, b))) {
    const item = group(sub, sub === key ? "" : sub.slice(key.length + 1), paths, changed);
    if (item.lit.length || sub === key) subs.push(item); else quiet.push([item.name, paths]);
  }
  if (quiet.length) {
    const names = quiet.map(([name]) => name);
    const name = names.length > 4 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
    subs.push({ ...group(`${key}/*`, name, quiet.flatMap(([, paths]) => paths), changed), quiet: true });
  }
  return { key, name: key, count: cells.length, cells: [], lit: [], subs };
}

export function mapSquares(paths: readonly string[], changedPaths: readonly string[]): SquareMap {
  const changed = new Set(changedPaths);
  const all = [...new Set([...paths, ...changedPaths])].sort(byPath);
  const tops = new Map<string, string[]>();
  for (const path of all) {
    const key = top(path);
    const list = tops.get(key);
    if (list) list.push(path); else tops.set(key, [path]);
  }
  const bySize = ([a, x]: [string, string[]], [b, y]: [string, string[]]) => y.length - x.length || byPath(a, b);
  const hot = [...tops].filter(([, cells]) => cells.some(path => changed.has(path))).sort(bySize);
  const cold = [...tops].filter(([, cells]) => !cells.some(path => changed.has(path))).sort(bySize);
  const far = cold.slice(0, FAR).map(([key, cells]) => group(key, key, cells, changed));
  const rest = cold.slice(FAR);
  if (rest.length) far.push({ ...group("*", "", rest.flatMap(([, cells]) => cells), changed), more: rest.length });
  return { total: all.length, near: hot.map(([key, cells]) => nearGroup(key, cells, changed)), far };
}

export function squareTarget(map: SquareMap, path: string | undefined): { group: string; index: number } | null {
  if (!path) return null;
  for (const group of map.near.flatMap(group => group.subs ?? [group])) {
    const index = group.cells.indexOf(path);
    if (index >= 0 && group.lit.includes(index)) return { group: group.key, index };
  }
  return null;
}
