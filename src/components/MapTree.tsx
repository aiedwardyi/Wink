import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MapWorker } from "../../shared/map-pane";
import { fmt, TREE, treeAlong, treeClimb, treeEdges, treeLayout, treeOrder, treeRoute, type MapClash, type Point, type TreeFont, type TreeIndex, type TreeItem } from "@/lib/map-tree";
import { mapWorkerColor } from "@/lib/map-worker-colors";
import "./MapTree.css";

interface Labels { folders(n: number): string; files(n: number): string; same: string; different: string }

interface MapTreeProps {
  index: TreeIndex;
  workers: readonly MapWorker[];
  team: boolean;
  slots: ReadonlyMap<string, number>;
  clashes: readonly MapClash[];
  current?: { path: string; worker: string; at: number };
  selected: string | null;
  follow: boolean;
  labels: Labels;
  onOpen(path: string): void;
}

interface Motion { fx: number; fy: number; tx: number; ty: number; x: number; y: number; t0: number }

// The arrow's tip: path point (2, 1) of the 18x20 viewBox drawn at 13x14.
const TIP = { x: 1.4, y: 0.7 };
// It rests 1px off the bottom-right corner of the row's 7px square, so its halo clears the square.
const corner = (row: Point) => ({ x: row.x + 8, y: row.y + 4.5 });
export const widths = new Map<string, number>();
let canvas: CanvasRenderingContext2D | null | undefined;
const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const ease = (k: number) => k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
const half = (n: number) => Math.round(n) + 0.5;
const top = (it: TreeItem, at: Point) => ({ x: at.x + (it.kind === "stack" ? 7 : it.bw / 2), y: at.y });

// A file whose branch just folded has no row: the arrow climbs from where it sat up through the box that now holds the file, along the buses, and down into the opening branch.
function foldRoute(items: readonly TreeItem[], start: Point, from: string, to: string, at: (it: TreeItem) => Point): Point[] | null {
  const down = treeClimb(items, to, at);
  if (!down) return null;
  const dir = from.slice(0, Math.max(0, from.lastIndexOf("/")));
  const holds = (it: TreeItem) => it.kind === "root" || (it.kind === "stack" ? it.dir!.path === dir
    : it.dir ? from.startsWith(it.dir.path + "/") : it.filesOf === dir || !!it.folds?.some(path => from.startsWith(path + "/")));
  // Items run row by row, so the last holder is the deepest.
  let node = items.findLast(holds);
  if (!node) return null;
  const cut = (id: string, key: "bus" | "busOf") => down.slice(0, down.findIndex(point => point[key] === id) + 1).reverse();
  const g = at(node);
  const points: Point[] = node.kind === "stack" ? [start] : [start, { x: top(node, g).x, y: g.y + TREE.BOX }];
  if (down.some(point => point.busOf === node!.id)) return [...points, ...cut(node.id, "busOf")];
  for (; node.parent; node = node.parent) {
    const parent: TreeItem = node.parent;
    const head = top(node, at(node));
    const bus = at(parent.kids?.[0] ?? node).y - TREE.VGAP / 2;
    points.push(head, { x: head.x, y: bus });
    if (down.some(point => point.bus === parent.id)) return [...points, ...cut(parent.id, "bus")];
    const pg = at(parent);
    points.push({ x: top(parent, pg).x, y: bus }, { x: top(parent, pg).x, y: pg.y + TREE.BOX });
  }
  return null;
}
// SAFETY: CSSProperties has no custom properties; this sets only --c.
const tint = (color?: string) => color ? { "--c": color } as CSSProperties : undefined;

export function measurer(element: HTMLElement, phone: boolean) {
  const style = getComputedStyle(element);
  const sans = style.getPropertyValue("--font-sans").trim() || "sans-serif";
  const mono = style.getPropertyValue("--font-mono").trim() || "monospace";
  const fonts: Record<TreeFont, string> = phone
    ? { root: `600 12px ${sans}`, dir: `500 11px ${sans}`, count: `400 10px ${sans}`, file: `400 10.5px ${mono}` }
    : { root: `600 12.5px ${sans}`, dir: `500 11.5px ${sans}`, count: `400 10px ${sans}`, file: `400 11px ${mono}` };
  if (canvas === undefined) canvas = document.createElement("canvas").getContext?.("2d") ?? null;
  return (text: string, font: TreeFont) => {
    const key = `${fonts[font]}\0${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      if (canvas) { canvas.font = fonts[font]; width = canvas.measureText(text).width; } else width = text.length * parseFloat(fonts[font].split(" ")[1]) * 0.62;
      if (widths.size >= 4096) widths.delete(widths.keys().next().value!);
      widths.set(key, width);
    }
    return width;
  };
}

const Clash = ({ same }: { same: boolean }) => <svg className="map-tree-x" data-same={same || undefined} viewBox="0 0 13 10" aria-hidden="true">
  <rect x=".5" y=".5" width="7.5" height="7.5" /><rect x="4.5" y="2" width="7.5" height="7.5" />{same && <path d="M4.5 2H8v6H4.5z" />}
</svg>;

export const MapTree = memo(function MapTree({ index, workers, team, slots, clashes, current, selected, follow, labels, onOpen }: MapTreeProps) {
  const view = useRef<HTMLDivElement>(null);
  const lines = useRef<SVGPathElement>(null);
  const hot = useRef<SVGPathElement>(null);
  const pin = useRef<HTMLSpanElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const motion = useRef(new Map<string, Motion>());
  const rows = useRef(new Set<string>());
  const hop = useRef<{ from?: string; to?: string; at?: number; t0: number; start?: Point }>({ t0: 0 });
  const spot = useRef<Point>(undefined);
  const held = useRef(false);
  const edit = useRef<MapTreeProps["current"]>(undefined);
  const frame = useRef(0);
  const [width, setWidth] = useState(0);
  const W = width || 560;
  const phone = W < 480;
  const color = (id: string) => mapWorkerColor(slots.get(id) ?? 99);
  const owners = useMemo(() => {
    const owners = new Map<string, string[]>();
    for (const worker of workers) for (const file of worker.files) owners.set(file.path, [...owners.get(file.path) ?? [], worker.id]);
    return owners;
  }, [workers]);
  const ownersKey = [...owners.keys()].join("\0");
  const clashBy = useMemo(() => new Map(clashes.toReversed().map(clash => [clash.path, clash])), [clashes]);
  const clashKey = clashes.map(clash => clash.path).join("\0");
  const focus = !follow && selected && owners.has(selected) ? selected : current?.path;
  const layout = useMemo(() => {
    const changed = new Set(owners.keys());
    const named = new Set([...clashBy.keys(), ...focus ? [focus] : []]);
    const rank = (path: string) => slots.get(owners.get(path)?.[0] ?? "") ?? 99;
    const measure = view.current ? measurer(view.current, phone) : (text: string) => text.length * 7;
    return { changed, ...treeLayout(index, { width: W, phone, changed, current: focus, team: team ? { named, marks: new Set(clashBy.keys()), rank } : undefined, measure, folders: labels.folders, files: labels.files }) };
  }, [index, W, phone, ownersKey, clashKey, focus, team, labels, slots]);
  const order = useMemo(() => treeOrder(index, layout.changed), [index, layout.changed]);
  const shown = useMemo(() => new Set(layout.items.flatMap(it => it.squares ?? it.files ?? [])), [layout.items]);
  const fill = (path: string) => {
    const ids = owners.get(path) ?? [];
    return ids.length > 1 ? `linear-gradient(135deg, ${color(ids[0])} 50%, ${color(ids[1])} 50%)` : color(ids[0] ?? "");
  };
  const under = (path: string) => {
    const prefix = path ? path + "/" : "";
    const ids = new Set<string>();
    for (const [file, list] of owners) if (file.startsWith(prefix)) for (const id of list) ids.add(id);
    return [...ids].toSorted((a, b) => (slots.get(a) ?? 99) - (slots.get(b) ?? 99));
  };

  useLayoutEffect(() => {
    const element = view.current!;
    const read = () => setWidth(element.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A held Up or Down jumps the arrow so fast scrolling stays fast.
  useLayoutEffect(() => {
    const key = (event: KeyboardEvent) => { held.current = event.type === "keydown" && event.repeat; };
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("keyup", key, true); };
  }, []);

  useLayoutEffect(() => {
    const now = performance.now();
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const fresh = motion.current.size === 0;
    const keep = new Set<string>();
    const fade = (element: Element | undefined) => { if (!fresh && !still) element?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: "ease-out" }); };
    for (const it of layout.items) {
      keep.add(it.id);
      const move = motion.current.get(it.id);
      if (!move) { motion.current.set(it.id, { fx: it.x, fy: it.y, tx: it.x, ty: it.y, x: it.x, y: it.y, t0: 0 }); fade(nodes.current.get(it.id)); }
      else if (move.tx !== it.x || move.ty !== it.y) Object.assign(move, { fx: move.x, fy: move.y, tx: it.x, ty: it.y, t0: still ? 0 : now });
    }
    for (const id of motion.current.keys()) if (!keep.has(id)) motion.current.delete(id);
    const found = new Map([...view.current!.querySelectorAll<HTMLElement>("[data-tree-row]")].map(row => [row.dataset.treeRow!, row]));
    for (const [path, row] of found) if (!rows.current.has(path) && nodes.current.has(row.closest<HTMLElement>(".map-tree-n")?.dataset.node ?? "")) fade(row);
    rows.current = new Set(found.keys());
    let scroll = false;
    if (current && (current.path !== edit.current?.path || current.at !== edit.current.at)) {
      edit.current = current;
      if (!fresh && !still) found.get(current.path)?.animate?.([{ backgroundColor: "transparent" }, { backgroundColor: "color-mix(in oklab, var(--c, var(--color-accent)) 22%, transparent)", offset: 0.3 }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
    }
    const stamp = focus === current?.path ? current?.at : 0;
    const at = (it: TreeItem): Point => motion.current.get(it.id) ?? it;
    if (focus && (focus !== hop.current.to || stamp !== hop.current.at)) {
      const from = fresh ? undefined : hop.current.to;
      const start = from && from !== focus && spot.current && !treeClimb(layout.items, from, at) ? spot.current : undefined;
      // The target square lights at once and the arrow sets off a beat later, so it reads as heading there.
      hop.current = { from, to: focus, at: stamp, t0: fresh || still || held.current ? 0 : now + 135, start };
      scroll = follow;
    }
    const tick = () => {
      frame.current = 0;
      const t = performance.now();
      let moving = false;
      for (const it of layout.items) {
        const move = motion.current.get(it.id)!;
        const k = ease((t - move.t0) / 420);
        if (k < 1) moving = true;
        move.x = move.fx + (move.tx - move.fx) * k;
        move.y = move.fy + (move.ty - move.fy) * k;
        const node = nodes.current.get(it.id);
        if (node) node.style.transform = `translate(${move.x.toFixed(1)}px, ${move.y.toFixed(1)}px)`;
      }
      lines.current?.setAttribute("d", treeEdges(layout.items, at));
      const { from, to, t0, start } = hop.current;
      const climb = to ? treeClimb(layout.items, to, at) : null;
      const shown = Math.min(1, Math.max(0, (t - t0 - 350) / 400));
      if (shown < 1) moving = true;
      hot.current?.setAttribute("d", climb ? "M" + climb.map(point => `${half(point.x)} ${half(point.y)}`).join("L") : "");
      hot.current?.style.setProperty("opacity", String(1 - (1 - shown) ** 3));
      if (pin.current) {
        const k = start ? 1 - (1 - Math.min(1, Math.max(0, (t - t0) / 450))) ** 3 : ease((t - t0) / 750);
        const trail = climb && from && from !== to && k < 1 ? start ? foldRoute(layout.items, start, from, to!, at) : treeRoute(layout.items, from, to!, at) : null;
        const route = trail && [...start ? [] : [corner(trail[0])], ...trail, corner(trail.at(-1)!)];
        const point = route ? treeAlong(route, k) : climb ? corner(climb[0]) : undefined;
        if (route) moving = true;
        spot.current = point;
        pin.current.style.opacity = point ? "1" : "0";
        if (point) pin.current.style.transform = `translate(${(point.x - TIP.x).toFixed(1)}px, ${(point.y - TIP.y).toFixed(1)}px)`;
      }
      if (moving && !document.hidden) frame.current = requestAnimationFrame(tick);
      else if (scroll) { scroll = false; found.get(to ?? "")?.scrollIntoView?.({ block: "nearest" }); }
    };
    cancelAnimationFrame(frame.current);
    tick();
    return () => cancelAnimationFrame(frame.current);
  }, [layout, current, follow, focus]);

  const row = (it: TreeItem, path: string, index: number) => {
    const changed = layout.changed.has(path);
    const clash = clashBy.get(path);
    const props = { className: "map-tree-file", "data-tree-row": path, "data-now": path === current?.path || undefined, "data-lit": path === focus || undefined, title: path,
      style: { top: 2 + (it.squaresHeight ?? 0) + index * TREE.LINE, ...tint(team ? fill(path) : undefined) } };
    const body = <><i /><span>{name(path)}</span>{clash && <Clash same={clash.same} />}</>;
    return changed
      ? <button key={path} type="button" {...props} data-map-file={path} data-state="changed" aria-current={selected === path} onClick={() => onOpen(path)}>{body}</button>
      : <span key={path} {...props}>{body}</span>;
  };
  // A folded box opens the first changed file it holds, which unfolds that branch.
  const folded = (it: TreeItem) => order.find(path => !shown.has(path) && (it.kind === "box" ? path.startsWith(it.dir!.path + "/")
    : it.folds?.some(dir => path.startsWith(dir + "/")) || it.filesOf === path.slice(0, Math.max(0, path.lastIndexOf("/")))));
  const box = (it: TreeItem) => {
    const dir = it.dir!;
    const ids = team ? under(dir.path) : [];
    const target = it.kind === "box" ? folded(it) : undefined;
    const Box = target ? "button" : "div";
    return <Box type={target ? "button" : undefined} className="map-tree-box" data-changed={(it.kind === "root" ? layout.changed.size > 0 : layout.lit.has(dir.path)) || undefined} style={{ width: it.bw }} onClick={target ? () => onOpen(target) : undefined}>
      <b>{it.kind === "root" ? dir.name : <>{dir.name}<i>/</i></>}</b><span>{fmt(dir.total)}</span>
      {ids.length > 0 && <s className="map-tree-ticks" style={{ background: `linear-gradient(90deg, ${ids.map((id, i) => `${color(id)} ${(i * 100 / ids.length).toFixed(2)}% ${((i + 1) * 100 / ids.length).toFixed(2)}%`).join(", ")})` }} />}
    </Box>;
  };
  const more = (it: TreeItem) => {
    const target = it.changed ? folded(it) : undefined;
    const body = <><b>{it.label}</b>{it.sub && <span>{it.sub}</span>}</>;
    return target
      ? <button type="button" className="map-tree-box map-tree-more" data-changed style={{ width: it.w }} onClick={() => onOpen(target)}>{body}</button>
      : <div className="map-tree-box map-tree-more" data-changed={it.changed || undefined} style={{ width: it.w }}>{body}</div>;
  };
  const ordered = workers.toSorted((a, b) => (slots.get(a.id) ?? 99) - (slots.get(b.id) ?? 99));
  const nick = (id: string) => workers.find(worker => worker.id === id)?.nick ?? id;

  return <>
    {team && <div className="map-tree-team">
      <div className="map-tree-legend">{ordered.map(worker => <span key={worker.id} data-now={worker.id === current?.worker || undefined}><i style={tint(color(worker.id))} />{worker.nick}<em>{worker.files.length}</em></span>)}</div>
      {clashes.map(clash => <div key={`${clash.path}\0${clash.a}\0${clash.b}`} className="map-tree-clash" title={clash.path}><Clash same={clash.same} /><code>{name(clash.path)}</code><span>{nick(clash.a)} + {nick(clash.b)} · {clash.same ? labels.same : labels.different}</span></div>)}
    </div>}
    <div ref={view} className="map-tree" data-team={team || undefined} style={{ height: layout.height }}>
      <svg className="map-tree-lines" aria-hidden="true"><path ref={lines} /><path ref={hot} className="map-tree-hot" style={team && current ? { stroke: color(current.worker) } : undefined} /></svg>
      {layout.items.map(it => <div key={it.id} ref={node => { if (node) nodes.current.set(it.id, node); else nodes.current.delete(it.id); }} className="map-tree-n" data-node={it.id} data-kind={it.kind} style={{ width: it.w }}>
        {it.dir && it.kind !== "stack" && box(it)}
        {it.kind === "more" && more(it)}
        {it.files && <div className="map-tree-files" style={{ top: it.kind === "col" ? TREE.BOX + TREE.SGAP : 0 }}>
          {it.squares && <div className="map-tree-sqs" style={{ width: it.per! * TREE.SQ }}>{it.squares.map(path => <button key={path} type="button" className="map-tree-sq" data-map-file={path} data-tree-row={it.files!.includes(path) ? undefined : path} aria-current={selected === path} aria-label={path} title={`${path}: ${(owners.get(path) ?? []).map(nick).join(", ")}`} style={tint(fill(path))} onClick={() => onOpen(path)} />)}</div>}
          {it.files.map((path, index) => row(it, path, index))}
          {it.hidden ? <span className="map-tree-hidden" style={{ top: 2 + it.files.length * TREE.LINE }}>{labels.files(it.hidden)}</span> : null}
        </div>}
      </div>)}
      <span ref={pin} className="map-tree-pin" aria-hidden="true"><svg viewBox="0 0 18 20"><path d="M2 1L16 12L9 13L5 19Z" /></svg></span>
    </div>
  </>;
});
