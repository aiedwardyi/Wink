import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { useI18n, type LocaleId } from "@/lib/i18n";
import { LIGHT_SKIN_IDS, useSkin } from "@/lib/skins";
import { WHATS_NEW, releaseNotesUrl, type WhatsNewTile } from "@/lib/whats-new";
import { useStore } from "@/state/store";
import type { SceneId } from "./ChatScene";
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

const holdStill = () => document.documentElement.hasAttribute("data-orbit-idle") || Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** Blurred, hidden or reduced motion: one frame instead of a loop that repaints every frame. */
function useStill(): boolean {
  const [still, setStill] = useState(holdStill);
  useEffect(() => {
    const update = () => setStill(holdStill());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-orbit-idle"] });
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    media?.addEventListener?.("change", update);
    update();
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", update);
    };
  }, []);
  return still;
}

function Still({ src }: { src: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const node = canvas.current;
      if (!node) return;
      node.width = image.naturalWidth;
      node.height = image.naturalHeight;
      node.getContext("2d")?.drawImage(image, 0, 0);
    };
    image.src = src;
    return () => {
      image.onload = null;
    };
  }, [src]);
  return <canvas ref={canvas} />;
}

function Tile({ tile, locale, onShow }: { tile: WhatsNewTile; locale: LocaleId; onShow: () => void }) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const seen = useSeen(frame);
  const still = useStill();
  const clip = (LIGHT_SKIN_IDS.has(useSkin()) && tile.lightClip) || tile.clip;
  const [how, setHow] = useState(false);
  return (
    <div className="whats-new-tile">
      <div ref={frame} className="whats-new-frame">
        {seen && (still ? <Still src={clip} /> : <img src={clip} alt="" draggable={false} />)}
      </div>
      <div className="whats-new-tile-title">{tile.title[locale]}</div>
      <div key={String(how)} className="whats-new-line">{how && tile.show !== "memory" ? tile.show[locale] : tile.line[locale]}</div>
      <button type="button" className="whats-new-show" aria-expanded={tile.show === "memory" ? undefined : how} onClick={() => (tile.show === "memory" ? onShow() : setHow((value) => !value))}>
        {t("whatsNew.showMe")}
      </button>
    </div>
  );
}

/** A release's notes, or the one-time row of an animated theme. */
export default function WhatsNewCard({ release, theme, closing, onClose }: { release?: string; theme?: SceneId; closing: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { dispatch } = useStore();
  const entry = release ? WHATS_NEW[release] : undefined;
  const title = theme ? t("whatsNew.themeMoves", { name: t(`settings.skin.${theme}`) }) : entry?.title[locale];
  const card = useRef<HTMLElement>(null);
  const visible = useSeen(card);
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, visible]);
  if (!title) return null;
  return (
    <div className="whats-new-dock">
      <section ref={card} className="whats-new" aria-label={title} data-closing={closing || undefined}>
        <div className="whats-new-head">
          {theme ? <p>{title}</p> : <h2>{title}</h2>}
          <button type="button" className="whats-new-x" aria-label={t("whatsNew.close")} title={t("whatsNew.close")} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {release && entry && (
          <>
            <div className="whats-new-tiles">
              {entry.tiles.map((tile) => (
                <Tile
                  key={tile.title.en}
                  tile={tile}
                  locale={locale}
                  onShow={() => dispatch({ type: "toggleSettings", open: true, memory: { line: "" } })}
                />
              ))}
            </div>
            <div className="whats-new-foot">
              <a href={releaseNotesUrl(release)} target="_blank" rel="noreferrer">{entry.more[locale]}</a>
              <button type="button" className="whats-new-done" onClick={onClose}>{t("whatsNew.gotIt")}</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
