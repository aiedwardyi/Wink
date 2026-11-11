import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Maximize, Minimize } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useBackLayer } from "@/lib/use-back-layer";

function canFullscreenWrapper(): boolean {
  return (
    Boolean(window.matchMedia?.("(pointer: coarse)").matches) &&
    Boolean(document.fullscreenEnabled) &&
    typeof HTMLElement.prototype.requestFullscreen === "function"
  );
}

// Chromium keeps focus in the seek bar after a scrub and it swallows Space; refocusing the video restores play/pause.
function refocusAfterSeek(event: SyntheticEvent<HTMLVideoElement>) {
  const video = event.currentTarget;
  if (document.activeElement !== video) return;
  video.blur();
  video.focus({ preventScroll: true });
}

const VIDEO = "max-h-96 max-w-full rounded-lg border border-hairline/30";

export function PhoneVideo({ src }: { src: string }) {
  const { t } = useI18n();
  const wrapper = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [available] = useState(canFullscreenWrapper);
  const [full, setFull] = useState(false);

  const exit = () => {
    if (document.fullscreenElement === wrapper.current) void document.exitFullscreen().catch(() => undefined);
  };
  useBackLayer(full, exit);

  useEffect(() => {
    if (!available) return;
    const sync = () => {
      const now = document.fullscreenElement === wrapper.current;
      setFull(now);
      // Focus makes the browser show the controls, so entry never starts with them hidden.
      if (now) video.current?.focus({ preventScroll: true });
    };
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      if (document.fullscreenElement === wrapper.current) void document.exitFullscreen().catch(() => undefined);
    };
  }, [available]);

  const toggle = () => {
    if (document.fullscreenElement === wrapper.current) exit();
    else void wrapper.current?.requestFullscreen().catch(() => undefined);
  };

  const player = (
    <video
      ref={video}
      src={src}
      controls
      controlsList={available ? "nofullscreen" : undefined}
      preload="metadata"
      playsInline
      onSeeked={refocusAfterSeek}
      data-phone-media="video"
      className={full ? "h-full w-full object-contain" : VIDEO}
    />
  );
  if (!available) return player;
  const label = t(full ? "chat.video.exitFullscreen" : "chat.video.fullscreen");
  return (
    <span ref={wrapper} className="relative inline-block max-w-full">
      {player}
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        data-phone-video-fullscreen
        className="absolute bottom-14 right-2 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/40"
      >
        {full ? <Minimize size={20} aria-hidden="true" /> : <Maximize size={20} aria-hidden="true" />}
      </button>
    </span>
  );
}
