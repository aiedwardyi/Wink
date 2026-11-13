import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { MapDiff, MapDiffLine, MapRepo, MapSnapshot } from "../../shared/map-pane";
import { request } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import { mapFollow, type MapSelection } from "@/lib/map-follow";
import { mapSquares, squareTarget, type SquareGroup, type SquareMap } from "@/lib/map-squares";
import "./MapPane.css";

const copy = {
  en: { empty: "No live workers", notGit: "Not a git folder", none: "No files changed", workers: "Choose worker", all: "Follow all workers", changed: (n: number) => `${n} ${n === 1 ? "file" : "files"} changed`, of: (n: ReactNode, total: number) => <>{n} of {total.toLocaleString("en-US")} files changed</>, files: "Changed files", legend: "One square, one file. Lit ones changed.", more: (n: number) => `${n} more folders`, following: (nick: string) => `Following ${nick}`, follow: (nick: string) => `Follow ${nick}`, unchanged: (n: number) => `${n} lines unchanged`, capped: "Large diff folded", binary: "Binary file", failed: "Could not load changes", loading: "Loading changes", retry: "Retry", whole: "Whole file" },
  ko: { empty: "실행 중인 작업자가 없어요", notGit: "Git 폴더가 아니에요", none: "변경된 파일이 없어요", workers: "작업자 선택", all: "모든 작업자 따라가기", changed: (n: number) => `파일 ${n}개 변경`, of: (n: ReactNode, total: number) => <>파일 {total.toLocaleString("ko-KR")}개 중 {n}개 변경</>, files: "변경된 파일", legend: "네모 하나가 파일 하나예요. 밝은 건 바뀐 파일이에요.", more: (n: number) => `폴더 ${n}개 더`, following: (nick: string) => `${nick} 따라가는 중`, follow: (nick: string) => `${nick} 따라가기`, unchanged: (n: number) => `변경 없는 ${n}줄`, capped: "큰 변경 내용은 일부 접었어요", binary: "바이너리 파일", failed: "변경 내용을 불러오지 못했어요", loading: "변경 내용 불러오는 중", retry: "다시 시도", whole: "전체 파일" },
};
const EMPTY: MapSnapshot = { workers: [] };
const INITIAL: MapSelection = { follow: true, worker: null, path: null, pinned: null };
const TRAIL = 6;
// The arrow's tip: path point (2, 1) of the 18x20 viewBox drawn at 17x18.
const TIP = { x: 2.2, y: 0.9 };
const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folder = (path: string) => path.includes("/") ? name(path.slice(0, path.lastIndexOf("/"))) : "";
type Step = { reason?: string; editedAt: number };
const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

const Cells = ({ group }: { group: SquareGroup }) => {
  const lit = new Set(group.lit);
  return <div className="map-cells" data-group={group.key}>{group.cells.map((path, index) => lit.has(index) ? <i key={path} data-on data-square={path} title={path} /> : <i key={path} title={path} />)}</div>;
};

const Squares = memo(function Squares({ map, repo, more }: { map: SquareMap; repo: string; more: (n: number) => string }) {
  const head = (group: SquareGroup, label: string) => <header><span>{label}</span><span>{group.count.toLocaleString("en-US")}</span></header>;
  return <>
    {map.near.length > 0 && <div className="map-near">{map.near.map(group => <section key={group.key} className="map-d">
      {head(group, group.key || repo)}
      {group.subs ? group.subs.map(sub => <div key={sub.key} className="map-sub" data-quiet={sub.quiet || undefined}>{sub.name && head(sub, sub.name)}<Cells group={sub} /></div>) : <Cells group={group} />}
    </section>)}</div>}
    <div className="map-far">{map.far.map(group => <section key={group.key} className="map-d" data-far>
      {head(group, group.more ? more(group.more) : group.key || repo)}
      <Cells group={group} />
    </section>)}</div>
  </>;
});

export function MapPane({ botId, maximized = false, active = true }: { botId?: string; maximized?: boolean; active?: boolean }) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [snapshot, setSnapshot] = useState<MapSnapshot>(EMPTY);
  const [selection, setSelection] = useState<MapSelection>(INITIAL);
  const [menu, setMenu] = useState(false);
  const [diff, setDiff] = useState<{ worker: string; path: string; whole: boolean; data: MapDiff; step?: Step; full?: MapDiff; opened?: number[] } | null>(null);
  const [whole, setWhole] = useState(false);
  const cache = useRef({ key: "", diffs: new Map<string, MapDiff>() });
  const [repo, setRepo] = useState<(MapRepo & { worker: string }) | null>(null);
  const [failed, setFailed] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [connection, setConnection] = useState(0);
  const [hops, setHops] = useState<{ worker?: string; paths: string[]; count: number }>({ paths: [], count: 0 });
  const [trail, setTrail] = useState<{ x: number; y: number }[]>([]);
  const [pin, setPin] = useState<{ x: number; y: number } | null>(null);
  const liveReady = useRef(false);
  const [ready, setReady] = useState(!botId);
  const squaresRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const chosen = mapFollow(selection, snapshot.workers);
  const worker = snapshot.workers.find(worker => worker.id === chosen.worker);
  const files = useMemo(() => (worker?.files ?? []).toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), [worker?.files]);
  const changedKey = files.map(file => file.path).join("\0");
  const paths = repo?.worker === worker?.id ? repo?.paths : undefined;
  const squares = useMemo(() => paths && mapSquares(paths, changedKey ? changedKey.split("\0") : []), [paths, changedKey]);
  const base = botId && `/api/bots/${encodeURIComponent(botId)}/map`;
  const openRef = useRef((_path: string) => {});
  openRef.current = path => setSelection({ ...chosen, follow: false, path });
  const open = useCallback((path: string) => openRef.current(path), []);
  const cached = (key: string) => {
    if (cache.current.key !== key) cache.current = { key, diffs: new Map() };
    return cache.current.diffs;
  };

  useEffect(() => {
    liveReady.current = false;
    if (!base || !active) return;
    setReady(false);
    const stream = new EventSource(`${base}/live`);
    stream.onmessage = event => {
      try {
        const data: MapSnapshot = JSON.parse(event.data);
        if (!liveReady.current) setConnection(value => value + 1);
        liveReady.current = true;
        setSnapshot(data);
        setConnectionFailed(false);
        setReady(true);
      } catch { setConnectionFailed(true); }
    };
    stream.onerror = () => { liveReady.current = false; setConnectionFailed(true); setReady(true); };
    return () => { liveReady.current = false; stream.close(); };
  }, [base, active]);

  useEffect(() => {
    if (!active || !liveReady.current || !base || !worker?.git) return;
    const controller = new AbortController();
    const id = worker.id;
    request(`${base}/repo?${new URLSearchParams({ worker: id })}`, { signal: controller.signal }).then((data: MapRepo) => {
      if (!controller.signal.aborted && Array.isArray(data?.paths)) setRepo({ worker: id, name: String(data.name ?? ""), paths: data.paths });
    }, () => {});
    return () => controller.abort();
  }, [base, worker?.id, worker?.git, active, connection]);

  useEffect(() => {
    if (!active || !liveReady.current) return;
    if (!base || !worker?.git || !chosen.path) { setDiff(null); return; }
    const controller = new AbortController();
    setFailed(false);
    const id = worker.id;
    const path = chosen.path;
    const step = path === worker.path ? { reason: worker.reason, editedAt: worker.editedAt } : undefined;
    const diffs = cached(`${id}\0${worker.editedAt}\0${connection}`);
    const hit = diffs.get(`${whole}\0${path}`);
    if (hit) { setDiff({ worker: id, path, whole, data: hit, step }); return; }
    request(`${base}/file?${new URLSearchParams({ worker: id, path, ...whole && { whole: "1" } })}`, { signal: controller.signal }).then((data: MapDiff) => {
      if (controller.signal.aborted) return;
      diffs.set(`${whole}\0${path}`, data);
      setDiff({ worker: id, path, whole, data, step });
    }, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [base, worker?.id, worker?.editedAt, worker?.path, worker?.reason, worker?.git, chosen.path, whole, retry, active, connection]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setMenu(false); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape, true); };
  }, [menu]);

  useEffect(() => {
    const path = worker?.path;
    setHops(previous => {
      if (previous.worker !== worker?.id) return { worker: worker?.id, paths: path ? [path] : [], count: previous.count + 1 };
      if (!path || previous.paths.at(-1) === path) return previous;
      return { worker: previous.worker, paths: [...previous.paths, path].slice(-TRAIL), count: previous.count + 1 };
    });
  }, [worker?.id, worker?.path]);

  useLayoutEffect(() => {
    if (!active) return;
    const map = squaresRef.current;
    const list = listRef.current;
    const place = () => {
      if (map && squares) {
        const box = map.getBoundingClientRect();
        const groups = new Map([...map.querySelectorAll<HTMLElement>("[data-group]")].map(group => [group.dataset.group, group]));
        setTrail(hops.paths.flatMap(path => {
          const target = squareTarget(squares, path);
          const cell = target && groups.get(target.group)?.children[target.index];
          if (!cell) return [];
          const rect = cell.getBoundingClientRect();
          return [{ x: Math.round(rect.left - box.left + rect.width / 2) + 0.5, y: Math.round(rect.top - box.top + rect.height / 2) + 0.5 }];
        }));
      } else setTrail([]);
      const row = list && [...list.querySelectorAll<HTMLElement>("[data-map-file]")].find(row => row.dataset.mapFile === worker?.path);
      const square = row?.querySelector("i");
      setPin(row && square ? { x: row.offsetLeft + square.offsetLeft + square.offsetWidth / 2 - TIP.x, y: row.offsetTop + square.offsetTop + square.offsetHeight / 2 - TIP.y } : null);
      if (row && chosen.follow) row.scrollIntoView?.({ block: "nearest" });
    };
    place();
    const observer = new ResizeObserver(place);
    for (const node of [map, list]) if (node) observer.observe(node);
    return () => observer.disconnect();
  }, [hops, squares, files, worker?.path, worker?.editedAt, chosen.follow, active]);

  const lines = trail.slice(1).map((point, index) => {
    const from = trail[index];
    const age = trail.length - 2 - index;
    const length = Math.abs(point.x - from.x) + Math.abs(point.y - from.y);
    return <path key={hops.count - age} d={`M${from.x} ${from.y}H${point.x}V${point.y}`} opacity={Math.max(0.22, 0.95 - age * 0.13)} data-new={age === 0 || undefined} strokeDasharray={length} style={{ "--len": length } as React.CSSProperties} />;
  });
  const blip = trail.length && hops.paths.at(-1) === worker?.path ? trail.at(-1) : undefined;
  const loaded = !failed && diff?.worker === worker?.id ? diff : null;
  const shown = loaded ? loaded.path : chosen.path;
  const step = loaded ? loaded.step : shown && shown === worker?.path ? { reason: worker.reason, editedAt: worker.editedAt } : undefined;
  // SAFETY: CSSProperties has no custom properties; this sets only --cell and --gap.
  const grid = squares && ({ "--cell": `${squares.size}px`, "--gap": `${squares.size > 5 ? 2 : 1}px` } as React.CSSProperties);
  const unfold = (line: number) => {
    if (!base || !loaded) return;
    const { worker: id, path, data } = loaded;
    const diffs = cache.current.diffs;
    const show = (full: MapDiff) => setDiff(current => current?.worker === id && current.path === path && current.data === data ? { ...current, full, opened: [...current.opened ?? [], line] } : current);
    const hit = diffs.get(`true\0${path}`);
    if (hit) return show(hit);
    request(`${base}/file?${new URLSearchParams({ worker: id, path, whole: "1" })}`).then((full: MapDiff) => { diffs.set(`true\0${path}`, full); show(full); }, () => {});
  };
  const move = (event: React.KeyboardEvent) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!delta || !files.length || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable], .map-worker-menu")) return;
    event.preventDefault();
    const index = files.findIndex(file => file.path === chosen.path);
    const next = index < 0 ? 0 : index + delta;
    if (!files[next]) return;
    open(files[next].path);
    const row = listRef.current?.querySelectorAll<HTMLElement>(".map-file")[next];
    if (event.target instanceof Element && event.target.matches(".map-file")) row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
  };
  const codeRow = (line: MapDiffLine, key: React.Key) => <div key={key} className="map-code-row" data-kind={line.kind}><u>{line.line}</u><b>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}</b><code>{line.text || " "}</code></div>;
  const crumbs = shown ? [repo?.worker === worker?.id ? repo?.name : "", ...shown.split("/")].filter(Boolean) : [];

  return <section className="verify-watch-frame map-pane" tabIndex={-1} onKeyDown={move} data-maximized={maximized || undefined} data-map-worker={worker?.id} data-map-path={chosen.path} data-map-edit={worker?.editedAt}>
    {!ready ? <p className="map-empty" role="status">{c.loading}</p> : !worker ? <p className="map-empty" role="status">{connectionFailed || snapshot.error ? c.failed : c.empty}</p> : <>
      <header className="map-head">
        <div ref={menuRef} className="map-worker-menu">
          <button type="button" className="map-worker" onClick={() => setMenu(!menu)} aria-label={c.workers} aria-haspopup="menu" aria-expanded={menu}><i /><span>{worker.nick}</span><ChevronDown size={12} /></button>
          {menu && <div role="menu" className="map-menu">
            <button type="button" role="menuitemradio" aria-checked={!chosen.pinned} onClick={() => { setSelection({ ...chosen, follow: true, pinned: null }); setMenu(false); }}>{c.all}</button>
            {snapshot.workers.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={chosen.pinned === item.id} onClick={() => { setSelection({ ...chosen, worker: item.id, pinned: item.id, follow: true }); setMenu(false); }}>{item.nick}</button>)}
          </div>}
        </div>
      </header>
      {!worker.git ? <p className="map-empty" role="status">{c.notGit}</p> : <>
        <div className="map-top">
          <div className="map-where">
            <span>{squares ? c.of(<b>{files.length}</b>, squares.total) : c.changed(files.length)}</span>
            <span>{[repo?.worker === worker.id && repo.name, worker.nick].filter(Boolean).join(" / ")}</span>
          </div>
          {squares && <div ref={squaresRef} className="map-squares" aria-hidden="true" data-near={squares.near.length > 0 || undefined} style={grid} onClick={event => {
            const path = event.target instanceof HTMLElement && event.target.dataset.square;
            if (path) open(path);
          }}>
            <Squares map={squares} repo={repo?.name ?? ""} more={c.more} />
            <svg className="map-trail">{lines}</svg>
            {blip && <i className="map-blip" style={{ left: blip.x, top: blip.y }} />}
          </div>}
          <div className="map-file-label"><span>{c.files}</span><span>{c.legend}</span></div>
          {!files.length ? <p className="map-empty" role="status">{c.none}</p> : <div ref={listRef} className="map-files" aria-label={c.changed(files.length)}>
            {files.map(file => <button key={file.path} type="button" className="map-file" data-map-file={file.path} data-hot={worker.path === file.path || undefined} aria-current={chosen.path === file.path} onClick={() => open(file.path)} title={file.path}>
              <i /><span className="map-file-name">{name(file.path)}</span><span className="map-folder">{folder(file.path)}</span><span className="map-delta">+{file.added}</span>
            </button>)}
            {pin && <span className="map-pin" aria-hidden="true" style={{ transform: `translate(${pin.x}px, ${pin.y}px)` }}><svg viewBox="0 0 18 20"><path d="M2 1L16 12L9 13L5 19Z" /></svg></span>}
          </div>}
        </div>
        {files.length > 0 && <>
          <div className="map-crumbs">
            <span className="map-path" title={shown ?? undefined}>{crumbs.map((part, index) => index === crumbs.length - 1 ? <b key={index}>{part}</b> : <span key={index}>{part} / </span>)}</span>
            <button type="button" className="map-whole" aria-pressed={whole} onClick={() => setWhole(!whole)}>{c.whole}</button>
            <button type="button" className="map-follow" aria-pressed={chosen.follow} onClick={() => setSelection({ ...chosen, follow: !chosen.follow })}><i />{chosen.follow ? c.following(worker.nick) : c.follow(worker.nick)}</button>
          </div>
          {shown && <div key={`${shown}:${step?.editedAt}`} className="map-step">
            <i />
            <h3 title={step?.reason ?? shown}>{step?.reason ?? shown}</h3>
            {step && step.editedAt > 0 && <time dateTime={new Date(step.editedAt).toISOString()}>{clock(step.editedAt)}</time>}
            {step?.reason && <p>{shown}</p>}
          </div>}
          <div className="map-code" aria-busy={!failed && (loaded?.path !== chosen.path || loaded.whole !== whole)}>
            {failed || connectionFailed || snapshot.error ? <p className="map-empty" role="status">{c.failed} <button type="button" onClick={() => setRetry(retry + 1)}>{c.retry}</button></p> : !loaded ? <p className="map-empty" role="status">{c.loading}</p> : loaded.data.binary ? <p className="map-empty">{c.binary}</p> : <>
              {loaded.data.lines.map((line, index) => {
                if (line.kind !== "fold") return codeRow(line, index);
                const start = line.line ?? 1;
                if (!loaded.full || !loaded.opened?.includes(start)) return <button key={index} type="button" className="map-gap" onClick={() => unfold(start)}>{c.unchanged(line.count ?? 0)}</button>;
                const opened = loaded.full.lines.filter(full => full.kind === "context" && full.line! >= start && full.line! < start + (line.count ?? 0));
                return [...opened.map(full => codeRow(full, `${index}:${full.line}`)), opened.length < (line.count ?? 0) && <div key={`${index}:capped`} className="map-gap">{c.capped}</div>];
              })}
              {loaded.data.capped && <div className="map-gap">{c.capped}</div>}
            </>}
          </div>
        </>}
      </>}
    </>}
  </section>;
}
