import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { useI18n, type LocaleId } from "@/lib/i18n";
import { LIGHT_SKIN_IDS, useSkin } from "@/lib/skins";
import { WHATS_NEW, releaseNotesUrl, type WhatsNewTile } from "@/lib/whats-new";
import { api, useStore } from "@/state/store";
import "./WhatsNewCard.css";

/** Animated images keep decoding while mounted, so a preview only mounts while it can be seen. */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    let inView = false;
    const update = () => setSeen(inView && document.visibilityState === "visible");
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(node);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref]);
  return seen;
}

function Tile({ tile, locale, onShow }: { tile: WhatsNewTile; locale: LocaleId; onShow: () => void }) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const seen = useSeen(frame);
  const light = LIGHT_SKIN_IDS.has(useSkin());
  const [how, setHow] = useState(false);
  return (
    <div className="whats-new-tile">
      <div ref={frame} className="whats-new-frame">
        {seen && <img src={(light && tile.lightClip) || tile.clip} alt="" draggable={false} />}
      </div>
      <div className="whats-new-tile-title">{tile.title[locale]}</div>
      <div key={String(how)} className="whats-new-line">{how && tile.show !== "memory" ? tile.show[locale] : tile.line[locale]}</div>
      <button type="button" className="whats-new-show" aria-expanded={tile.show === "memory" ? undefined : how} onClick={() => (tile.show === "memory" ? onShow() : setHow((value) => !value))}>
        {t("whatsNew.showMe")}
      </button>
    </div>
  );
}

export default function WhatsNewCard({ release, closing, onClose }: { release: string; closing: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { dispatch } = useStore();
  const entry = WHATS_NEW[release];
  const card = useRef<HTMLElement>(null);
  const visible = useSeen(card);
  const marked = useRef(false);
  useEffect(() => {
    if (!entry || !visible || marked.current) return;
    marked.current = true;
    void api("/api/whats-new/seen", { method: "POST", body: JSON.stringify({ release }) }).catch(() => {});
  }, [entry, visible, release]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!entry) return null;
  return (
    <div className="whats-new-dock">
      <section ref={card} className="whats-new" aria-label={entry.title[locale]} data-closing={closing || undefined}>
        <div className="whats-new-head">
          <h2>{entry.title[locale]}</h2>
          <button type="button" className="whats-new-x" aria-label={t("whatsNew.close")} title={t("whatsNew.close")} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="whats-new-tiles">
          {entry.tiles.map((tile) => (
            <Tile
              key={tile.title.en}
              tile={tile}
              locale={locale}
              onShow={() => {
                dispatch({ type: "toggleSettings", open: true, memory: { line: "" } });
                onClose();
              }}
            />
          ))}
        </div>
        <div className="whats-new-foot">
          <a href={releaseNotesUrl(release)} target="_blank" rel="noreferrer">{entry.more[locale]}</a>
          <button type="button" className="whats-new-done" onClick={onClose}>{t("whatsNew.gotIt")}</button>
        </div>
      </section>
    </div>
  );
}
