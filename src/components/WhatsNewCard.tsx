import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { useI18n, type LocaleId } from "@/lib/i18n";
import { LIGHT_SKIN_IDS, useSkin, type SkinId } from "@/lib/skins";
import { reducedMotion } from "@/lib/phone-swipe";
import { FORUM_SELECTION } from "@/lib/board";
import { showMap, showPane, showTimeline, showWorkers } from "@/lib/show-pane";
import { WHATS_NEW, releaseNotesUrl, type WhatsNewTarget, type WhatsNewTile } from "@/lib/whats-new";
import { useStore } from "@/state/store";
import { SCENE_NAME, sceneOf, type SceneId } from "./ChatScene";
import { Miniature } from "./SkinPicker";
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

const isVideo = (src: string) => src.endsWith(".mp4");

function Still({ src }: { src: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = (source: CanvasImageSource, width: number, height: number) => {
      const node = canvas.current;
      if (!node) return;
      node.width = width;
      node.height = height;
      node.getContext("2d")?.drawImage(source, 0, 0);
    };
    if (isVideo(src)) {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.onloadeddata = () => draw(video, video.videoWidth, video.videoHeight);
      video.src = src;
      return () => {
        video.onloadeddata = null;
        video.removeAttribute("src");
        video.load();
      };
    }
    const image = new Image();
    image.onload = () => draw(image, image.naturalWidth, image.naturalHeight);
    image.src = src;
    return () => {
      image.onload = null;
    };
  }, [src]);
  return <canvas ref={canvas} />;
}

function ThemeMiniature({ skin, visible }: { skin: SkinId; visible: boolean }) {
  const [preview, setPreview] = useState<"waiting" | "playing" | "still">(() => reducedMotion() ? "still" : "waiting");
  useEffect(() => {
    if (visible && preview === "waiting") setPreview("playing");
  }, [visible, preview]);
  useEffect(() => {
    if (preview !== "playing") return;
    const timer = setTimeout(() => setPreview("still"), 3000);
    return () => clearTimeout(timer);
  }, [preview]);
  return <Miniature skin={skin} still={preview !== "playing" || !visible} />;
}

function Tile({ tile, locale, onShow }: { tile: WhatsNewTile; locale: LocaleId; onShow: (target: WhatsNewTarget) => void }) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const seen = useSeen(frame);
  const still = useStill();
  const clip = (LIGHT_SKIN_IDS.has(useSkin()) && tile.lightClip) || tile.clip;
  const [how, setHow] = useState(false);
  return (
    <div className="whats-new-tile">
      <div ref={frame} className="whats-new-frame">
        {seen && (still ? <Still src={clip} /> : isVideo(clip) ? <video src={clip} autoPlay muted loop playsInline disablePictureInPicture /> : <img src={clip} alt="" draggable={false} />)}
      </div>
      <div className="whats-new-tile-title">{tile.title[locale]}</div>
      <div key={String(how)} className="whats-new-line">{how && "how" in tile ? tile.how[locale] : tile.line[locale]}</div>
      <button type="button" className="whats-new-show" aria-expanded={"how" in tile ? how : undefined} onClick={() => ("how" in tile ? setHow((value) => !value) : onShow(tile.show))}>
        {t("whatsNew.showMe")}
      </button>
    </div>
  );
}

/** A release's notes, or the one-time row of an animated theme. */
export default function WhatsNewCard({ release, theme, closing, onClose }: { release?: string; theme?: SceneId; closing: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const entry = release ? WHATS_NEW[release] : undefined;
  const title = theme ? t("whatsNew.themeMoves", { name: t(SCENE_NAME[theme]) }) : entry?.title[locale];
  const skin = useSkin();
  const card = useRef<HTMLElement>(null);
  const visible = useSeen(card);
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      // a side pane the tour opened takes this Escape, and the card stays for the next tile
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && !document.querySelector(".show-pane:not([data-closing])")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, visible]);
  if (!title) return null;
  return (
    <div className="whats-new-dock">
      <section ref={card} className="whats-new" aria-label={title} data-closing={closing || undefined}>
        <div className="whats-new-head">
          {theme && (
            <div className="whats-new-mini">
              {/* The variant that was picked; the theme's own once the pick has moved on and the row is closing. */}
              <ThemeMiniature key={theme} skin={sceneOf(skin) === theme ? skin : theme} visible={visible} />
            </div>
          )}
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
                  onShow={(target) => {
                    const thread = state.bots.find((bot) => bot.id === state.selectedId)?.threadId;
                    if (target === "memory") dispatch({ type: "toggleSettings", open: true, memory: { line: "" } });
                    else if (target === "map") {
                      if (thread) showMap(thread);
                    } else if (target === "workers") {
                      if (thread) showWorkers(thread);
                    } else if (target === "timeline") {
                      if (thread) showTimeline(thread);
                    } else if (target === "pane") {
                      if (thread) showPane(thread);
                    } else if (target === "forum") dispatch({ type: "select", id: FORUM_SELECTION, reveal: true });
                    else if (target === "models") window.dispatchEvent(new Event("orbit:open-model-picker"));
                    else if (target === "quick") window.dispatchEvent(new CustomEvent("orbit:open-model-picker", { detail: { view: "quick" } }));
                    else dispatch({ type: "toggleAppSettings", open: true, section: "themes", skins: target.skins });
                  }}
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