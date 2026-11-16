import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Play } from "lucide-react";

import { useThumb } from "@/lib/media-thumbs";

const HOVER_MS = 250;

/** A clip's first frame and a play badge, played muted under a resting mouse; children stand in when no frame can be made. */
export function MediaClip({ src, name, children }: { src: string; name: string; children: ReactNode }) {
  const poster = useThumb(src, true);
  const [loaded, setLoaded] = useState(false);
  const [hover, setHover] = useState<"wait" | "play">();
  const tile = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!hover) return;
    const timer = hover === "wait" ? setTimeout(() => setHover("play"), HOVER_MS) : undefined;
    const scrolled = (event: Event) => { if (event.target instanceof Node && event.target.contains(tile.current)) setHover(undefined); };
    addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      removeEventListener("scroll", scrolled, { capture: true });
    };
  }, [hover]);

  if (poster === src) return children;
  const enter = (event: ReactPointerEvent) => { if (event.pointerType === "mouse") setHover("wait"); };
  return (
    <span ref={tile} className="absolute inset-0" onPointerEnter={enter} onPointerLeave={() => setHover(undefined)}>
      {poster && <img src={poster} alt="" decoding="async" data-loaded={loaded || undefined} onLoad={() => setLoaded(true)} className="size-full object-cover" />}
      {hover === "play" && <HoverPlay src={src} />}
      <span className="absolute bottom-1.5 left-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
        <Play size={11} aria-hidden="true" className="ml-px fill-current" />
      </span>
      <span className="sr-only">{name}</span>
    </span>
  );
}

function HoverPlay({ src }: { src: string }) {
  const [playing, setPlaying] = useState(false);
  const ref = useCallback((video: HTMLVideoElement) => start(video, src), [src]);
  return <video ref={ref} muted loop playsInline disablePictureInPicture data-loaded={playing || undefined} onPlaying={() => setPlaying(true)}
    className="absolute inset-0 size-full object-cover" />;
}

// a removed video keeps its decoder and connection until collected, so let go of both now
function start(video: HTMLVideoElement, src: string) {
  video.setAttribute("src", src);
  video.muted = true;
  void video.play().catch(() => {});
  return () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
}
