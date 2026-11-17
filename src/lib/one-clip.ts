// One clip at a time: starting a video pauses every other playing one.
export function pauseOtherClips(current: HTMLVideoElement) {
  for (const video of document.querySelectorAll("video")) {
    if (video !== current && !video.paused) video.pause();
  }
}
