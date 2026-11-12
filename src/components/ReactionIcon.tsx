import { cn } from "@/lib/cn";

const SVG = import.meta.glob<string>("../assets/reactions/*.svg", { query: "?raw", import: "default", eager: true });

const SLUG: Record<string, string> = {
  "👍": "thumbs-up",
  "👎": "thumbs-down",
  "❤": "red-heart",
  "🔥": "fire",
  "🚀": "rocket",
  "💡": "light-bulb",
  "👌": "ok-hand",
  "❓": "red-question-mark",
  "😂": "face-with-tears-of-joy",
  "😮": "face-with-open-mouth",
  "👀": "eyes",
  "🤝": "handshake",
  "💀": "skull",
  "🎉": "party-popper",
};

const markup = (emoji: string) => SVG[`../assets/reactions/${SLUG[emoji.replace(/️/g, "")]}.svg`];

/** Color icon for a reaction emoji; older marks with no icon keep the glyph. */
export function ReactionIcon({ emoji, size, className }: { emoji: string; size: number; className?: string }) {
  const svg = markup(emoji);
  if (!svg) return <span data-emoji={emoji} className={className}>{emoji}</span>;
  return (
    <span
      data-emoji={emoji}
      aria-hidden
      className={cn("inline-block shrink-0 [&>svg]:size-full", className)}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
