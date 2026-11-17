/** The chat's audio player; a tap on an audio file anywhere else plays it in one of these. */
export function InlineAudio({ src, autoPlay }: { src: string; autoPlay?: boolean }) {
  return <audio src={src} controls autoPlay={autoPlay} data-phone-media="audio" className="max-w-full" />;
}
