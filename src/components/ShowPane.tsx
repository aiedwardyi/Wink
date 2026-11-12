import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Download, ExternalLink, FileText, Globe, Image as ImageIcon, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import type { VerifyCardData } from "../../shared/live-verify";
import { useI18n } from "@/lib/i18n";
import type { MediaSource } from "@/lib/show-media";
import { closeShow, lastShown, linkedFileSrc, saveFile, showItem, showMedia, showName, type ShowItem } from "@/lib/show-pane";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { closeVerifyWatch } from "@/lib/verify-watch";
import { ShowMedia } from "./ShowMedia";
import { VerifyDocWatchFrame } from "./VerifyDocWatch";
import { VerifyWatchFrame } from "./VerifyWatch";
import "./VerifyWatch.css";
import "./ShowPane.css";

const ShowPdf = lazy(() => import("./ShowPdf"));
const ICON = { image: ImageIcon, pdf: FileText, page: Globe };

interface ShowPaneProps {
  item?: ShowItem;
  watch?: { card: VerifyCardData; threadId: string; live: boolean };
  /** the Media tab is open */
  media?: boolean;
  source?: MediaSource;
  hidden: boolean;
  closing?: boolean;
}

/** The right slot's one pane: a bot's file, or the checker. A phone gets it as a full-screen sheet. */
export function ShowPane({ item, watch, media = false, source, hidden, closing = false }: ShowPaneProps) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const [maximized, setMaximized] = useState(false);
  const expanded = maximized && !phone;
  const close = watch ? closeVerifyWatch : closeShow;
  const again = source && lastShown(source.threadId);
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
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, closing, expanded]);

  const pane = (
    <aside ref={ref} style={dock.current ? { "--dock": `${dock.current}px` } as CSSProperties : undefined} className="verify-watch show-pane animate-panel-in" data-verify-watch data-side-panel="" data-wide={item || media ? "" : undefined} data-closing={closing || undefined} inert={closing || undefined}>
      <div className="show-pane-head">
        {!phone && <button type="button" onClick={close} aria-label={t("show.collapse")} title={t("show.collapse")} className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"><ChevronRight size={18} /></button>}
        <div role="tablist" className="show-pane-tabs">
          <button type="button" role="tab" aria-selected={!media} disabled={media && !again} onClick={() => media && again && showItem(again)}>{t("show.tab")}</button>
          {source && <button type="button" role="tab" aria-selected={media} onClick={() => showMedia(source.threadId)}>{t("show.media")}</button>}
        </div>
        <span className="verify-watch-grow" />
        {!phone && <button type="button" className="verify-watch-icon" onClick={() => setMaximized(!maximized)} aria-label={t(expanded ? "show.restore" : "show.maximize")} title={t(expanded ? "show.restore" : "show.maximize")}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
        <button type="button" className="verify-watch-icon" onClick={close} aria-label={t("show.close")} title={t("show.close")}><X size={15} /></button>
      </div>
      {media && source
        ? <ShowMedia key={`${source.threadId}:${source.roomId}`} source={source} maximized={expanded} />
        : watch
        ? watch.card.doc
          ? <VerifyDocWatchFrame key={`${watch.card.runId}:${watch.live}`} {...watch} hidden={hidden} closing={closing} hosted={{ maximized: expanded }} onClose={closeVerifyWatch} />
          : <VerifyWatchFrame key={`${watch.card.runId}:${watch.live}`} {...watch} hidden={hidden} closing={closing} hosted={{ maximized: expanded }} onClose={closeVerifyWatch} />
        : item && <ShowFrame key={`${item.threadId}:${item.src ?? item.path}`} item={item} maximized={expanded} />}
    </aside>
  );
  // The chat's dock is a size container, which would trap a fixed sheet under the app's own buttons.
  return phone ? createPortal(pane, document.body) : pane;
}

function ShowFrame({ item, maximized }: { item: ShowItem; maximized: boolean }) {
  const { t } = useI18n();
  const src = item.src ?? linkedFileSrc(item.threadId, item.path);
  const name = showName(item.path);
  const Icon = ICON[item.kind];
  const [loads, setLoads] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // A missing page would load the server's JSON error into the frame.
  useEffect(() => {
    if (item.kind !== "page") return;
    let alive = true;
    fetch(src, { headers: { Range: "bytes=0-0" } })
      .then((res) => { if (alive && !res.ok && res.status !== 416) setFailed(true); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [item.kind, src]);

  const open = () => {
    const openFile = item.src ? undefined : window.ogb?.openFile;
    if (openFile) void openFile(item.path).catch(() => {});
    else window.open(src, "_blank", "noopener,noreferrer");
  };
  const reload = () => { setReady(false); setLoads(loads + 1); };

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
              : <iframe key={loads} src={src} sandbox="allow-scripts" title={name} onLoad={() => setReady(true)} />}
      </div>
    </div>
  );
}
