import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileCode, Folder } from "lucide-react";
import type { MapDiff, MapSnapshot } from "../../shared/map-pane";
import { request } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import { mapFollow, mapTree, type MapNode, type MapSelection } from "@/lib/map-tree";
import "./MapPane.css";

const copy = {
  en: { empty: "No live workers", notGit: "Not a git folder", none: "No files changed", follow: "Follow", workers: "Choose worker", all: "Follow all workers", changed: (n: number) => `${n} ${n === 1 ? "file" : "files"} changed`, unchanged: (n: number) => `${n} lines unchanged`, capped: "Large diff folded", binary: "Binary file", failed: "Could not load changes", loading: "Loading changes", retry: "Retry" },
  ko: { empty: "실행 중인 작업자가 없어요", notGit: "Git 폴더가 아니에요", none: "변경된 파일이 없어요", follow: "따라가기", workers: "작업자 선택", all: "모든 작업자 따라가기", changed: (n: number) => `파일 ${n}개 변경`, unchanged: (n: number) => `변경 없는 ${n}줄`, capped: "큰 변경 내용은 일부 접었어요", binary: "바이너리 파일", failed: "변경 내용을 불러오지 못했어요", loading: "변경 내용 불러오는 중", retry: "다시 시도" },
};
const EMPTY: MapSnapshot = { workers: [] };
const INITIAL: MapSelection = { follow: true, worker: null, path: null, pinned: null };

export function MapPane({ botId, maximized = false, active = true }: { botId?: string; maximized?: boolean; active?: boolean }) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [snapshot, setSnapshot] = useState<MapSnapshot>(EMPTY);
  const [selection, setSelection] = useState<MapSelection>(INITIAL);
  const [menu, setMenu] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<MapDiff | null>(null);
  const [failed, setFailed] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(!botId);
  const treeRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pin, setPin] = useState<number | null>(null);
  const chosen = mapFollow(selection, snapshot.workers);
  const worker = snapshot.workers.find(worker => worker.id === chosen.worker);
  const tree = useMemo(() => mapTree(worker?.files ?? []), [worker?.files]);
  const base = botId && `/api/bots/${encodeURIComponent(botId)}/map`;

  useEffect(() => {
    if (!base || !active) return;
    const stream = new EventSource(`${base}/live`);
    stream.onmessage = event => {
      try {
        const data: MapSnapshot = JSON.parse(event.data);
        setSnapshot(data);
        setConnectionFailed(false);
        setReady(true);
      } catch { setConnectionFailed(true); }
    };
    stream.onerror = () => { setConnectionFailed(true); setReady(true); };
    return () => stream.close();
  }, [base, active]);

  useEffect(() => {
    if (!active) return;
    if (!base || !worker?.git || !chosen.path) { setDiff(null); return; }
    const controller = new AbortController();
    setDiff(null);
    setFailed(false);
    const query = new URLSearchParams({ worker: worker.id, path: chosen.path });
    request(`${base}/file?${query}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setDiff(data);
    }, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [base, worker?.id, worker?.editedAt, worker?.git, chosen.path, retry, active]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setMenu(false); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape, true); };
  }, [menu]);

  useLayoutEffect(() => {
    const root = treeRef.current;
    const row = root && [...root.querySelectorAll<HTMLElement>("[data-map-file]")].find(row => row.dataset.mapFile === worker?.path);
    setPin(row ? row.offsetTop + row.offsetHeight / 2 - 4 : null);
    if (row && chosen.follow) row.scrollIntoView?.({ block: "nearest" });
  }, [worker?.path, worker?.editedAt, tree, closed, chosen.follow]);

  useEffect(() => {
    const edited = worker?.path;
    if (!chosen.follow || !edited) return;
    setClosed(previous => {
      const next = new Set([...previous].filter(path => !edited.startsWith(`${path}/`)));
      return next.size === previous.size ? previous : next;
    });
  }, [worker?.id, worker?.path, worker?.editedAt, chosen.follow]);

  const rows = (nodes: MapNode[], depth = 0): React.ReactNode => nodes.map(node => {
    const folder = Boolean(node.children);
    const expanded = folder && !closed.has(node.path);
    const select = () => {
      if (!folder) setSelection({ ...chosen, follow: false, path: node.path });
      else setClosed(previous => { const next = new Set(previous); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next; });
    };
    return <div key={node.path} role="none">
      <button type="button" role="treeitem" aria-level={depth + 1} aria-expanded={folder ? Boolean(expanded) : undefined} aria-selected={!folder ? chosen.path === node.path : undefined} data-map-file={!folder ? node.path : undefined} data-hot={!folder && worker?.path === node.path || undefined} className="map-row" style={{ paddingLeft: 6 + depth * 12 }} onClick={select} title={node.path}>
        {folder ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <FileCode size={12} />}
        {folder && <Folder size={12} />}
        <span className="map-file-name">{node.name}</span>
        <span className="map-counts"><b>+{node.added}</b><i>-{node.removed}</i></span>
        {!folder && worker?.path === node.path && <span key={worker.editedAt} className="map-flash" aria-hidden="true" />}
      </button>
      {expanded && <div role="group">{rows(node.children!, depth + 1)}</div>}
    </div>;
  });

  return <section className="verify-watch-frame map-pane" data-maximized={maximized || undefined} data-map-worker={worker?.id} data-map-path={chosen.path} data-map-edit={worker?.editedAt}>
    {!ready ? <p className="map-empty" role="status">{c.loading}</p> : !worker ? <p className="map-empty" role="status">{connectionFailed || snapshot.error ? c.failed : c.empty}</p> : <>
      <header className="map-head">
        <div ref={menuRef} className="map-worker-menu">
          <button type="button" className="map-worker" onClick={() => setMenu(!menu)} aria-label={c.workers} aria-haspopup="menu" aria-expanded={menu}><i /><span>{worker.nick}</span><ChevronDown size={12} /></button>
          {menu && <div role="menu" className="map-menu">
            <button type="button" role="menuitemradio" aria-checked={!chosen.pinned} onClick={() => { setSelection({ ...chosen, follow: true, pinned: null }); setMenu(false); }}>{c.all}</button>
            {snapshot.workers.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={chosen.pinned === item.id} onClick={() => { setSelection({ ...chosen, worker: item.id, pinned: item.id, follow: true }); setMenu(false); }}>{item.nick}</button>)}
          </div>}
        </div>
        <button type="button" className="map-follow" aria-pressed={chosen.follow} onClick={() => setSelection({ ...chosen, follow: !chosen.follow })}><i />{c.follow}</button>
        <div className="map-task" title={worker.task}>{worker.task}</div>
        <div className="map-tally">{c.changed(worker.files.length)}</div>
      </header>
      {!worker.git ? <p className="map-empty" role="status">{c.notGit}</p> : !worker.files.length ? <p className="map-empty" role="status">{c.none}</p> : <>
        <div className="map-tree-scroll"><div ref={treeRef} role="tree" aria-label={c.changed(worker.files.length)} className="map-tree">
          {rows(tree)}
          {pin !== null && <i className="map-pointer" aria-hidden="true" style={{ transform: `translateY(${pin}px)` }} />}
        </div></div>
        <div className="map-diff-head"><FileCode size={13} /><span>{chosen.path}</span></div>
        {worker.reason && <p className="map-reason" title={worker.reason}>{worker.reason}</p>}
        <div className="map-code" aria-busy={!diff && !failed}>
          {failed || connectionFailed || snapshot.error ? <p className="map-empty" role="status">{c.failed} <button type="button" onClick={() => setRetry(retry + 1)}>{c.retry}</button></p> : !diff ? <p className="map-empty" role="status">{c.loading}</p> : diff.binary ? <p className="map-empty">{c.binary}</p> : <>
            {diff.lines.map((line, index) => line.kind === "fold" ? <div key={index} className="map-gap">{c.unchanged(line.count ?? 0)}</div> : <div key={index} className="map-code-row" data-kind={line.kind}><u>{line.line}</u><b>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}</b><code>{line.text || " "}</code></div>)}
            {diff.capped && <div className="map-gap">{c.capped}</div>}
          </>}
        </div>
      </>}
    </>}
  </section>;
}
