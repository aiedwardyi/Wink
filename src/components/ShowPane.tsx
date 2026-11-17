import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, FileText, Folder, Globe, Image as ImageIcon, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import type { VerifyCardData } from "../../shared/live-verify";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { mediaFile, type MediaSource } from "@/lib/show-media";
import { lastShown, linkedFileSrc, linkedFolder, saveFile, showCheck, showItem, showMap, showMedia, showName, showTimeline, showWorkers, takeFolder, usePanePulse, watchFolder, type FolderListing, type ShowItem } from "@/lib/show-pane";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { closePane, closeVerifyWatch, openVerifyWatch, verifyCardAction } from "@/lib/verify-watch";
import { MediaFiles, ShowMedia } from "./ShowMedia";
import { TimelinePane } from "./TimelinePane";
import { VerifyDocWatchFrame } from "./VerifyDocWatch";
import { VerifyWatchFrame } from "./VerifyWatch";
import { listedFor, useSharedWorkers, WorkerPage } from "./WorkerRows";
import "./VerifyWatch.css";
import "./ShowPane.css";

const ShowPdf = lazy(() => import("./ShowPdf"));
const MapPane = lazy(() => import("./MapPane").then(module => ({ default: module.MapPane })));
const ICON = { image: ImageIcon, pdf: FileText, page: Globe, text: FileText, folder: Folder };
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
  profileName?: string;
  botId?: string;
  /** the chat's last check, which the Check tab opens */
  card?: VerifyCardData;
  source?: MediaSource;
  hidden: boolean;
  closing?: boolean;
}

/** The right slot's one pane: the chat's workers, a bot's file, the checker and the chat's media, a tab each. A phone gets it as a full-screen sheet. */
export function ShowPane({ item, watch, media = false, check = false, map = false, workers = false, timeline = false, profileName, botId, card, source, hidden, closing = false }: ShowPaneProps) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const [maximized, setMaximized] = useState(false);
  const expanded = maximized && !phone;
  const again = source && lastShown(source.threadId);
  const pulses = usePanePulse();
  const [pulsed, setPulsed] = useState(pulses);
  const crew = useSharedWorkers(source?.threadId);
  const hasWorkers = Boolean(crew && (crew.onOpenTerminal || listedFor(crew).length > 0));
  const tab = workers && source ? "workers" : map ? "map" : timeline ? "timeline" : media && source ? "media" : watch && (check || !item) ? "check" : "show";
  // A phone watches a doc check live; only a site check waits for the end.
  const action = card && verifyCardAction(card, phone && !card.doc);
  const checkable = Boolean(watch) || action === "live" || action === "watch";
  const openCheck = () => {
    if (watch) showCheck(watch.threadId);
    else if (card && source) openVerifyWatch({ threadId: source.threadId, owner: card.owner, live: action === "live" });
  };
  const ref = useRef<HTMLElement>(null);
  const dock = useRef<number | undefined>(undefined);
  // The sidebar unfolds as this closes; its open width keeps the content from reflowing mid-exit.
  if (!closing) dock.current = undefined;
  else dock.current ??= ref.current?.getBoundingClientRect().width;

  useEffect(() => {
    if (closing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (expanded) { event.preventDefault(); setMaximized(false); }
      else closePane();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closing, expanded]);

  const pane = (
    <aside ref={ref} style={dock.current ? { "--dock": `${dock.current}px` } as CSSProperties : undefined} className={cn("verify-watch show-pane max-md:animate-panel-in md:animate-panel-slide md:*:animate-fade-in", pulses !== pulsed && "arrival-glow")} onAnimationEnd={(event) => { if (event.animationName === "arrival-glow-once") setPulsed(pulses); }} data-verify-watch data-side-panel="" data-tab={tab} data-wide={tab !== "check" ? "" : undefined} data-closing={closing || undefined} inert={closing || undefined}>
      <div className="show-pane-head">
        <div role="tablist" className="show-pane-tabs">
          {source && (hasWorkers || tab === "workers") && <button type="button" role="tab" aria-selected={tab === "workers"} onClick={() => showWorkers(source.threadId)}>{t("show.workers")}</button>}
          <button type="button" role="tab" aria-selected={tab === "show"} disabled={tab !== "show" && !again} onClick={() => tab !== "show" && again && showItem(again)}>{t("show.tab")}</button>
          {source && <button type="button" role="tab" aria-selected={tab === "media"} onClick={() => showMedia(source.threadId)}>{t("show.media")}</button>}
          {checkable && <button type="button" role="tab" aria-selected={tab === "check"} onClick={openCheck}>{t("show.check")}</button>}
          {source && botId && <button type="button" role="tab" aria-selected={tab === "map"} onClick={() => showMap(source.threadId)}>{t("show.map")}</button>}
          {source && botId && <button type="button" role="tab" aria-selected={tab === "timeline"} onClick={() => showTimeline(source.threadId)}>{t("show.timeline")}</button>}
        </div>
        <span className="verify-watch-grow" />
        {!phone && <button type="button" className="verify-watch-icon" onClick={() => setMaximized(!maximized)} aria-label={t(expanded ? "show.restore" : "show.maximize")} title={t(expanded ? "show.restore" : "show.maximize")}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
        <button type="button" className="verify-watch-icon" onClick={closePane} aria-label={t("show.close")} title={t("show.close")}><X size={15} /></button>
      </div>
      {item && (item.kind === "folder"
        ? <ShowFolder key={`${item.threadId}:${item.path}`} item={item} maximized={expanded} />
        : <ShowFrame key={`${item.threadId}:${item.src ?? item.path}`} item={item} maximized={expanded} />)}
      {watch && (watch.card.doc
        ? <VerifyDocWatchFrame key={`${watch.card.runId}:${watch.live}`} {...watch} hidden={hidden} closing={closing} hosted={{ maximized: expanded }} onClose={closeVerifyWatch} />
        : <VerifyWatchFrame key={`${watch.card.runId}:${watch.live}`} {...watch} hidden={hidden} closing={closing} hosted={{ maximized: expanded }} onClose={closeVerifyWatch} />)}
      {tab === "media" && source && <ShowMedia key={`${source.threadId}:${source.roomId}`} source={source} maximized={expanded} />}
      {tab === "workers" && <WorkerPage source={crew} maximized={expanded} onClose={closePane} />}
      {tab === "map" && botId && <Suspense fallback={null}><MapPane key={botId} botId={botId} maximized={expanded} active={!hidden && !closing} /></Suspense>}
      {tab === "timeline" && botId && source && <TimelinePane key={botId} botId={botId} threadId={source.threadId} maximized={expanded} profileName={profileName} />}
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

function ShowFrame({ item, maximized }: { item: ShowItem; maximized: boolean }) {
  const { t } = useI18n();
  const src = item.src ?? linkedFileSrc(item.threadId, item.path);
  const name = showName(item.path);
  const Icon = ICON[item.kind];
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

  const open = () => {
    const openFile = item.src ? undefined : window.ogb?.openFile;
    if (openFile) void openFile(item.path).catch(() => {});
    else window.open(src, "_blank", "noopener,noreferrer");
  };
  const reload = () => { setReady(false); setFailed(false); setPageSrc(undefined); setLoads(loads + 1); };

  return (
    <div className="verify-watch-frame show-frame" data-kind={item.kind} data-maximized={maximized || undefined}>
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
function ShowFolder({ item, maximized }: { item: ShowItem; maximized: boolean }) {
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
    <div className="verify-watch-frame show-frame show-media" data-kind="folder" data-maximized={maximized || undefined} aria-busy={!files && !failed || undefined}>
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
