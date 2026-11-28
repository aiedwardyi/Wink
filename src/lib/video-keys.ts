// Chromium keeps focus and keys on a clicked control inside the video, so Space presses the seek bar or full screen button again.
export function holdVideoKeys(video: HTMLVideoElement) {
  const back = () => {
    if (document.activeElement !== video) return;
    video.blur();
    video.focus({ preventScroll: true });
  };
  video.addEventListener("seeked", back);
  document.addEventListener("fullscreenchange", back);
  return () => {
    video.removeEventListener("seeked", back);
    document.removeEventListener("fullscreenchange", back);
  };
}
