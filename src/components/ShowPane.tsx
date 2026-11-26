import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, Folder, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import type { VerifyCardData } from "../../shared/live-verify";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { mediaFile, type MediaSource } from "@/lib/show-media";
import { openOutside, saveFile } from "@/lib/open-file";
import { closeTab, linkedFileSrc, linkedFolder, PANE_TOOLS, showItem, showName, tabKey, takeFolder, usePanePulse, usePaneTabs, watchFolder, type FolderListing, type PaneEntry, type ShowItem } from "@/lib/show-pane";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { canWatch, closePane, closeVerifyWatch, openPaneTool } from "@/lib/verify-watch";
import { edgeFade } from "./Segmented";
import { FILE_ICON, PaneEdge, PaneTabs, PaneToolList, PaneToolMenu, TOOL_ICON, TOOL_LABEL, usePaneWidth, type TabView, type ToolRow } from "./PaneTabs";
import { MediaFiles, ShowMedia } from "./ShowMedia";
import { TimelinePane } from "./TimelinePane";
import { VerifyDocWatchFrame } from "./VerifyDocWatch";
import { VerifyWatchFrame } from "./VerifyWatch";
import { ShowPaneButton } from "./ShowPaneButton";
import { listedFor, useSharedWorkers, WorkerPage } from "./WorkerRows";
import "./VerifyWatch.css";
import "./ShowPane.css";

const ShowPdf = lazy(() => import("./ShowPdf"));
const MapPane = lazy(() => import("./MapPane").then(module => ({ default: module.MapPane })));
// Matches Segmented's fade: the open tab keeps clear of it.
const TAB_FADE = 24;
// Past this a text file is a log to open in an editor, not something to read in the pane.
const TEXT_MAX = 1_000_000;

interface ShowPaneProps {
  item?: ShowItem;
  watch?: { card: VerifyCardData; threadId: string; live: boolean };
  /** the Media tab is open */
  media?: boolean;
  /** the Check tab is open */
  check?: boolean;
  map?: boolean;
  /** the Workers tab is open */
  workers?: boolean;
  timeline?: boolean;
  /** the pane is open with no tab: it shows the tool list */
  tools?: boolean;
  profileName?: string;
  botId?: string;
  /** the chat's last check, which the Check tab opens */
  card?: VerifyCardData;
  source?: MediaSource;
  hidden: boolean;
  closing?: boolean;
}

/** The right slot's one pane: the chat's workers, a bot's file, the checker and the chat's media, a tab each. A phone gets it as a full-screen sheet. */
export function ShowPane({ item, watch, media = false, check = false, map = false, workers = false, timeline = false, tools = false, profileName, botId, card, source, hidden, closing = false }: ShowPaneProps) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const [maximized, setMaximized] = useState(false);
  const expanded = maximized && !phone;
  const pulses = usePanePulse();
  const [pulsed, setPulsed] = useState(pulses);
  const crew = useSharedWorkers(source?.threadId);
  const hasWorkers = Boolean(crew && (crew.onOpenTerminal || listedFor(crew).length > 0));
  const tab = tools ? "tools" : workers && source ? "workers" : map ? "map" : timeline ? "timeline" : media && source ? "media" : watch && (check || !item) ? "check" : item ? "show" : "tools";
  const checkable = Boolean(watch) || canWatch(card, phone);
  const threadId = source?.threadId ?? item?.threadId ?? watch?.threadId;
  const opened = usePaneTabs(threadId);
  const activeEntry: PaneEntry | null = tab === "show" ? item! : tab === "tools" ? null : tab;
  const active = activeEntry && tabKey(activeEntry);
  // Today's rules for when a tool is there: Workers with helpers, Check with a check, Map and Timeline in a bot chat.
  const there = (entry: PaneEntry) => entry === "workers" ? Boolean(source && (hasWorkers || tab === "workers")) : entry === "media" ? Boolean(source) : entry === "check" ? checkable : entry === "map" || entry === "timeline" ? Boolean(source && botId) : true;
  const shown = opened.filter(there);
  if (activeEntry && !shown.some((entry) => tabKey(entry) === active)) shown.push(activeEntry);
  const views: TabView[] = shown.map((entry) => typeof entry === "string"
    ? { key: entry, entry, name: t(TOOL_LABEL[entry]), icon: TOOL_ICON[entry] }
    : { key: tabKey(entry), entry, name: showName(entry.path.replace(/[\\/]+$/, "")), icon: FILE_ICON[entry.kind] });
  // A tool this chat kind never has is left out; one it can have but has nothing for yet is dim, so the list keeps one shape.
  const rows: ToolRow[] = PANE_TOOLS.flatMap((tool): ToolRow[] =>
    tool === "workers" ? (source && !source.roomId ? [{ tool, off: hasWorkers ? undefined : t("show.toolOff.workers") }] : [])
    : tool === "check" ? [{ tool, off: checkable ? undefined : t("show.toolOff.check") }]
    : tool === "media" ? (source ? [{ tool }] : [])
    : source && botId ? [{ tool }] : []);
  const open = (entry: PaneEntry) => {
    if (!threadId) return;
    if (typeof entry === "string") openPaneTool(entry, threadId, card, phone);
    else showItem(entry);
  };
  const close = (view: TabView, index: number) => {
    if (!threadId) return;
    const next = (views[index + 1] ?? views[index - 1])?.entry ?? null;
    closeTab(threadId, view.key, next === "check" ? null : next);
    if (view.key === "check") closeVerifyWatch();
    // The checker opens from its card, which the store does not hold.
    if (next === "check" && view.key === active) openPaneTool("check", threadId, card, phone);
  };
  // Each tab opened while the pane is up stays mounted behind the open one, so going back to it never reloads.
  const [kept, setKept] = useState<{ threadId?: string; entries: readonly PaneEntry[] }>({ entries: [] });
  let keep = kept.threadId === threadId ? kept.entries.filter((entry) => tabKey(entry) === active || opened.some((tab) => tabKey(tab) === tabKey(entry))) : [];
  if (activeEntry && !keep.some((entry) => tabKey(entry) === active)) keep = [...keep, activeEntry];
  if (kept.threadId !== threadId || keep.map(tabKey).join("\n") !== kept.entries.map(tabKey).join("\n")) setKept({ threadId, entries: keep });
  const hides = (entry: PaneEntry) => tabKey(entry) !== active || undefined;
  const [said, setSaid] = useState("");
  const [paneWidth, setPaneWidth] = usePaneWidth();
  const order = views.map((view) => view.key).join("\n");
  const ref = useRef<HTMLElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const aim = useRef<number | null>(null);
  const [fade, setFade] = useState<string>();
  const dock = useRef<number | undefined>(undefined);
  // The sidebar unfolds as this closes; its open width keeps the content from reflowing mid-exit.
  if (!closing) dock.current = undefined;
  else dock.current ??= ref.current?.getBoundingClientRect().width;

  // The row scrolls when its tabs do not fit: the open tab glides to the middle, clear of the edge fade, and the edge with more tabs fades.
  useLayoutEffect(() => {
    const row = strip.current;
    if (!row) return;
    const place = () => {
      const on = row.querySelector<HTMLElement>('[aria-selected="true"]');
      if (on && row.scrollWidth > row.clientWidth) {
        const box = row.getBoundingClientRect();
        const pick = on.getBoundingClientRect();
        if (pick.left < box.left + TAB_FADE || pick.right > box.right - TAB_FADE) {
          const glide = placed.current && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          row.scrollBy({ left: (pick.left + pick.right - box.left - box.right) / 2, behavior: glide ? "smooth" : "instant" });
        }
      }
      placed.current = true;
      setFade(edgeFade(row, TAB_FADE));
    };
    place();
    const settle = () => { aim.current = null; };
    row.addEventListener("scrollend", settle);
    const observer = window.ResizeObserver ? new ResizeObserver(place) : undefined;
    observer?.observe(row);
    for (const button of row.querySelectorAll("button")) observer?.observe(button);
    return () => { observer?.disconnect(); row.removeEventListener("scrollend", settle); };
  }, [tab, order]);

  // A mouse wheel only turns up and down, so over the row it moves the row sideways; a trackpad's own sideways swipe is left alone.
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    const row = event.currentTarget;
    if (event.deltaX) return;
    const from = aim.current ?? row.scrollLeft;
    const to = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, from + event.deltaY));
    if (to === from) return;
    aim.current = to;
    row.scrollTo({ left: to, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };

  useEffect(() => {
    if (closing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (expanded) { event.preventDefault(); setMaximized(false); }
      else { event.preventDefault(); closePane(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closing, expanded]);

  const pane = (
    <aside ref={ref} style={{ "--pane-width": paneWidth ? `${paneWidth}px` : undefined, "--dock": dock.current ? `${dock.current}px` : undefined } as CSSProperties} className={cn("verify-watch show-pane max-md:animate-panel-in md:animate-panel-slide md:*:animate-fade-in", pulses !== pulsed && "arrival-glow")} onAnimationEnd={(event) => { if (event.animationName === "arrival-glow-once") setPulsed(pulses); }} data-verify-watch data-side-panel="" data-tab={tab} data-wide="" data-closing={closing || undefined} inert={closing || undefined}>
      {!phone && !expanded && !closing && <PaneEdge pane={ref} width={paneWidth} onWidth={setPaneWidth} />}
      <div className="show-pane-head">
        {threadId && views.length > 0 && <div ref={strip} role="tablist" className="show-pane-tabs" onScroll={(event) => setFade(edgeFade(event.currentTarget, TAB_FADE))} onWheel={wheel} style={{ maskImage: fade, WebkitMaskImage: fade }}>
          <PaneTabs row={strip} threadId={threadId} tabs={views} active={active} onOpen={open} onClose={close} onSay={setSaid} />
        </div>}
        {threadId && <PaneToolMenu rows={rows} onPick={open} />}
        <span className="sr-only" aria-live="polite">{said}</span>
        <span className="verify-watch-grow" />
        {!phone && <button type="button" className="verify-watch-icon" onClick={() => setMaximized(!maximized)} aria-label={t(expanded ? "show.restore" : "show.maximize")} title={t(expanded ? "show.restore" : "show.maximize")}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>}
        {!phone && (source?.threadId || item?.threadId || watch?.threadId) ? <ShowPaneButton threadId={(source?.threadId || item?.threadId || watch?.threadId)!} workers={crew} inPane /> : <button type="button" className="verify-watch-icon" onClick={closePane} aria-label={t("show.close")} title={t("show.close")}><X size={18} /></button>}
      </div>
      {keep.map((entry) => typeof entry === "string" ? null : entry.kind === "folder"
        ? <ShowFolder key={`${entry.threadId}:${entry.path}`} item={entry} maximized={expanded} kept={hides(entry)} />
        : <ShowFrame key={`${entry.threadId}:${entry.src ?? entry.path}`} item={entry} maximized={expanded} kept={hides(entry)} />)}
      {watch && (watch.card.doc
        ? <VerifyDocWatchFrame key={`${watch.card.runId}:${watch.live}`} {...watch} hidden={hidden || Boolean(hides("check"))} closing={closing} hosted={{ maximized: expanded }} kept={hides("check")} onClose={closeVerifyWatch} />
        : <VerifyWatchFrame key={`${watch.card.runId}:${watch.live}`} {...watch} hidden={hidden || Boolean(hides("check"))} closing={closing} hosted={{ maximized: expanded }} kept={hides("check")} onClose={closeVerifyWatch} />)}
      {tab === "tools" && <PaneToolList rows={rows} onPick={open} />}
      {keep.includes("media") && source && <ShowMedia key={`${source.threadId}:${source.roomId}`} source={source} maximized={expanded} kept={hides("media")} />}
      {keep.includes("workers") && <WorkerPage source={crew} maximized={expanded} kept={hides("workers")} onClose={closePane} />}
      {keep.includes("map") && botId && <Suspense fallback={null}><MapPane key={botId} botId={botId} maximized={expanded} active={tab === "map" && !hidden && !closing} kept={hides("map")} /></Suspense>}
      {keep.includes("timeline") && botId && source && <TimelinePane key={botId} botId={botId} threadId={source.threadId} maximized={expanded} closing={closing} profileName={profileName} kept={hides("timeline")} />}
    </aside>
  );
  // The chat's dock is a size container, which would trap a fixed sheet under the app's own buttons. One portal box moves between the dock and the body, so crossing the phone width keeps the pane mounted.
  const [box] = useState(() => Object.assign(document.createElement("div"), { style: "display: contents" }));
  const place = useCallback((slot: HTMLDivElement | null) => {
    if (!slot) return;
    (phone ? document.body : slot).append(box);
    return () => box.remove();
  }, [phone, box]);
  return <><div ref={place} className="contents" />{createPortal(pane, box)}</>;
}

function ShowFrame({ item, maximized, kept }: { item: ShowItem; maximized: boolean; kept?: boolean }) {
  const { t } = useI18n();
  const src = item.src ?? linkedFileSrc(item.threadId, item.path);
  const name = showName(item.path);
  const Icon = FILE_ICON[item.kind];
  const [loads, setLoads] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pageSrc, setPageSrc] = useState<string>();
  const [text, setText] = useState<string>();

  useEffect(() => {
    if (item.kind !== "text") return;
    let alive = true;
    fetch(src)
      .then(async (res) => {
        if (!res.ok || Number(res.headers.get("content-length")) > TEXT_MAX) {
          void res.body?.cancel();
          throw new Error("unshowable");
        }
        const body = await res.text();
        if (body.length > TEXT_MAX) throw new Error("unshowable");
        if (!alive) return;
        setText(body);
        setReady(true);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [item.kind, src]);

  // Resolve the page's grant in the app; the opaque frame cannot authenticate itself.
  useEffect(() => {
    if (item.kind !== "page") return;
    let alive = true;
    fetch(src, { headers: { Range: "bytes=0-0" } })
      .then((res) => {
        if (!alive) return;
        if (!res.ok && res.status !== 416) setFailed(true);
        else setPageSrc(res.url);
      }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [item.kind, src, loads]);

  const open = () => openOutside(src, item.src ? undefined : item.path);
  const reload = () => { setReady(false); setFailed(false); setPageSrc(undefined); setLoads(loads + 1); };

  return (
    <div className="verify-watch-frame show-frame" data-kind={item.kind} data-maximized={maximized || undefined} data-kept={kept}>
      <div className="verify-watch-bar show-frame-bar">
        <Icon size={14} aria-hidden="true" className="show-frame-icon" />
        <span className="show-frame-name" title={item.path}>{name}</span>
        {item.kind === "page" && <button type="button" className="verify-watch-icon" onClick={reload} aria-label={t("show.reload")} title={t("show.reload")}><RefreshCw size={14} /></button>}
        <button type="button" className="verify-watch-icon" onClick={() => saveFile(src, name, item.src ? undefined : item.path)} aria-label={t("show.save")} title={t("show.save")}><Download size={14} /></button>
        <button type="button" className="verify-watch-icon" onClick={open} aria-label={t("show.open")} title={t("show.open")}><ExternalLink size={14} /></button>
      </div>
      <div className="show-stage" data-ready={ready || undefined}>
        {failed
          ? <div className="verify-watch-banner" role="status">{t("show.failed")} <button type="button" data-show-fallback className="ml-1 underline" onClick={open}>{t("show.open")}</button></div>
          : item.kind === "image"
            ? <img src={src} alt={name} onLoad={() => setReady(true)} onError={() => setFailed(true)} />
            : item.kind === "pdf"
              ? <Suspense fallback={null}><ShowPdf src={src} onReady={() => setReady(true)} onFail={() => setFailed(true)} /></Suspense>
              : item.kind === "text"
                ? text !== undefined && <pre>{text}</pre>
                : pageSrc && <iframe key={loads} src={pageSrc} sandbox="allow-scripts" title={name} onLoad={() => setReady(true)} />}
      </div>
    </div>
  );
}

/** A linked folder through the Media list: pictures step with the arrows, a page or PDF shows here, the rest download. */
function ShowFolder({ item, maximized, kept }: { item: ShowItem; maximized: boolean; kept?: boolean }) {
  const { t } = useI18n();
  const [listing, setListing] = useState<FolderListing | null>(() => takeFolder(item.threadId, item.path));
  const [failed, setFailed] = useState(false);
  const name = showName(item.path.replace(/[\\/]+$/, ""));

  useEffect(() => watchFolder(item.threadId, item.path, (got) => {
    setFailed(false);
    setListing(got);
  }), [item.threadId, item.path]);

  // Reopened from the Show tab, the folder lists again.
  useEffect(() => {
    if (listing) return;
    let alive = true;
    void linkedFolder(item.threadId, item.path).then((got) => {
      if (!alive) return;
      if (got) setListing(got);
      else setFailed(true);
    });
    return () => { alive = false; };
  }, [item.threadId, item.path, listing]);

  const files = useMemo(() => listing?.files.map((file) => mediaFile(item.threadId, { kind: "l", name: file.name, ref: file.path, size: file.size }, file.modified)) ?? null, [item.threadId, listing]);

  return (
    <div className="verify-watch-frame show-frame show-media" data-kind="folder" data-maximized={maximized || undefined} data-kept={kept} aria-busy={!files && !failed || undefined}>
      <div className="verify-watch-bar show-frame-bar">
        <Folder size={14} aria-hidden="true" className="show-frame-icon" />
        <span className="show-frame-name" title={item.path}>{name}</span>
      </div>
      {failed
        ? <div className="verify-watch-banner" role="status">{t("show.folderFailed")}</div>
        : <MediaFiles files={files} pickFor={`${item.threadId}\n${item.path}`} empty="chat.folder.empty">
          {listing && listing.more > 0 && <p data-folder-more className="show-media-empty">{t(listing.more === 1 ? "chat.folder.moreOne" : "chat.folder.more", { count: listing.more })}</p>}
        </MediaFiles>}
    </div>
  );
}
