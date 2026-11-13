import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { MapDiff, MapDiffLine, MapRepo, MapSnapshot } from "../../shared/map-pane";
import { request } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import { mapFollow, type MapSelection } from "@/lib/map-follow";
import { mapClashes, treeIndex, treeOrder } from "@/lib/map-tree";
import { mapWorkerSlots } from "@/lib/map-worker-colors";
import { MapTree } from "./MapTree";
import "./MapPane.css";

const copy = {
  en: { empty: "No live workers", walk: (total: number) => `${total.toLocaleString("en-US")} files · Not a git folder`, workers: "Choose worker", all: "Follow all workers", changed: (n: number) => `${n} ${n === 1 ? "file" : "files"} changed`, of: (n: ReactNode, total: number) => <>Changed {n} of {total.toLocaleString("en-US")} files</>,
    team: (workers: number, n: number, total: number, clashes: number) => <><b>{workers}</b> workers · <b>{n}</b> of {total.toLocaleString("en-US")} files changed{clashes > 0 && <> · <b>{clashes}</b> {clashes === 1 ? "clash" : "clashes"}</>}</>, crew: (n: number) => `${n} workers`,
    tree: { folders: (n: number) => `+${n} ${n === 1 ? "folder" : "folders"}`, files: (n: number) => `+${n.toLocaleString("en-US")} ${n === 1 ? "file" : "files"}`, same: "same lines", different: "different lines" }, following: (nick: string) => `Following ${nick}`, follow: (nick: string) => `Follow ${nick}`, unchanged: (n: number) => `${n} lines unchanged`, capped: "Large diff folded", binary: "Binary file", failed: "Could not load changes", loading: "Loading changes", retry: "Retry", whole: "Whole file" },
  ko: { empty: "실행 중인 작업자가 없어요", walk: (total: number) => `파일 ${total.toLocaleString("ko-KR")}개 · Git 폴더가 아니에요`, workers: "작업자 선택", all: "모든 작업자 따라가기", changed: (n: number) => `파일 ${n}개 변경`, of: (n: ReactNode, total: number) => <>파일 {total.toLocaleString("ko-KR")}개 중 {n}개 변경</>,
    team: (workers: number, n: number, total: number, clashes: number) => <>작업자 <b>{workers}</b>명 · 파일 {total.toLocaleString("ko-KR")}개 중 <b>{n}</b>개 변경{clashes > 0 && <> · 겹침 <b>{clashes}</b>개</>}</>, crew: (n: number) => `작업자 ${n}명`,
    tree: { folders: (n: number) => `폴더 +${n}`, files: (n: number) => `파일 +${n.toLocaleString("ko-KR")}`, same: "같은 줄", different: "다른 줄" }, following: (nick: string) => `${nick} 따라가는 중`, follow: (nick: string) => `${nick} 따라가기`, unchanged: (n: number) => `변경 없는 ${n}줄`, capped: "큰 변경 내용은 일부 접었어요", binary: "바이너리 파일", failed: "변경 내용을 불러오지 못했어요", loading: "변경 내용 불러오는 중", retry: "다시 시도", whole: "전체 파일" },
};
const EMPTY: MapSnapshot = { workers: [] };
const INITIAL: MapSelection = { follow: true, worker: null, path: null, pinned: null };
type Step = { reason?: string; editedAt: number };
const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

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
  const liveReady = useRef(false);
  const [ready, setReady] = useState(!botId);
  const topRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slots = useRef<ReadonlyMap<string, number>>(new Map());
  slots.current = mapWorkerSlots(slots.current, snapshot.workers.map(worker => worker.id));
  const chosen = mapFollow(selection, snapshot.workers);
  const worker = snapshot.workers.find(worker => worker.id === chosen.worker);
  const files = worker?.files ?? [];
  const team = !chosen.pinned && snapshot.workers.length > 1;
  const onTree = useMemo(() => team ? snapshot.workers : worker ? [worker] : [], [team, snapshot.workers, worker]);
  const changed = useMemo(() => new Set(onTree.flatMap(worker => worker.files.map(file => file.path))), [onTree]);
  const changedKey = [...changed].join("\0");
  const clashes = useMemo(() => team ? mapClashes(snapshot.workers) : [], [team, snapshot.workers]);
  const repoWorker = team ? snapshot.workers[0]?.id : worker?.id;
  const paths = repo?.worker === repoWorker ? repo?.paths : undefined;
  const known = useMemo(() => new Set(paths), [paths]);
  const extra = changedKey ? changedKey.split("\0").filter(path => !known.has(path)) : [];
  const extraKey = extra.join("\0");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const index = useMemo(() => paths && treeIndex(repo?.name ?? "", extra.length ? [...paths, ...extra] : paths), [paths, extraKey]);
  const order = useMemo(() => index ? treeOrder(index, new Set(changedKey.split("\0"))) : [], [index, changedKey]);
  const current = useMemo(() => worker?.path ? { path: worker.path, worker: worker.id, at: worker.editedAt } : undefined, [worker?.path, worker?.id, worker?.editedAt]);
  const base = botId && `/api/bots/${encodeURIComponent(botId)}/map`;
  const openRef = useRef((_path: string) => {});
  openRef.current = path => {
    const owners = snapshot.workers.filter(item => item.files.some(file => file.path === path));
    const owner = owners.find(item => item.id === worker?.id) ?? owners.reduce<typeof owners[number] | undefined>((last, item) => !last || item.editedAt > last.editedAt ? item : last, undefined);
    setSelection({ ...chosen, follow: false, worker: owner?.id ?? chosen.worker, path });
  };
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
    if (!active || !liveReady.current || !base || !repoWorker) return;
    const controller = new AbortController();
    const id = repoWorker;
    request(`${base}/repo?${new URLSearchParams({ worker: id })}`, { signal: controller.signal }).then((data: MapRepo) => {
      if (!controller.signal.aborted && Array.isArray(data?.paths)) setRepo({ worker: id, name: String(data.name ?? ""), paths: data.paths });
    }, () => {});
    return () => controller.abort();
  }, [base, repoWorker, active, connection]);

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

  const loaded = !failed && diff?.worker === worker?.id ? diff : null;
  const shown = loaded ? loaded.path : chosen.path;
  const step = loaded ? loaded.step : shown && shown === worker?.path ? { reason: worker.reason, editedAt: worker.editedAt } : undefined;
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
    if (!delta || !order.length || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable], .map-worker-menu")) return;
    event.preventDefault();
    const at = chosen.path ? order.indexOf(chosen.path) : -1;
    const next = order[at < 0 ? 0 : at + delta];
    if (!next) return;
    open(next);
    const row = [...topRef.current?.querySelectorAll<HTMLElement>("[data-map-file]") ?? []].find(row => row.dataset.mapFile === next);
    if (event.target instanceof Element && event.target.matches("[data-map-file]")) row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
  };
  const codeRow = (line: MapDiffLine, key: React.Key) => <div key={key} className="map-code-row" data-kind={line.kind}><u>{line.line}</u><b>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}</b><code>{line.text || " "}</code></div>;
  const crumbs = shown ? [paths ? repo?.name : "", ...shown.split("/")].filter(Boolean) : [];

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
      <div ref={topRef} className="map-top">
        <div className="map-where">
          <span>{!index ? c.changed(files.length) : !worker.git ? c.walk(index.size) : team ? c.team(snapshot.workers.length, changed.size, index.size, clashes.length) : c.of(<b>{files.length}</b>, index.size)}</span>
          <span>{[paths && repo?.name, team ? c.crew(snapshot.workers.length) : worker.nick].filter(Boolean).join(" / ")}</span>
        </div>
        {index && <MapTree index={index} workers={onTree} team={team} slots={slots.current} clashes={clashes} current={current} selected={chosen.path} follow={chosen.follow} labels={c.tree} onOpen={open} />}
      </div>
      {/* Git flow row */}
      {worker.git && files.length > 0 && <>
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
  </section>;
}
