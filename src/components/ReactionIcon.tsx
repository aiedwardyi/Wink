import { cn } from "@/lib/cn";

// Files, not inline markup: inline copies share gradient ids and draw blank once the first copy is skipped by layout.
const ICONS = import.meta.glob<string>("../assets/reactions/*.svg", { query: "?no-inline", import: "default", eager: true });

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

const url = (emoji: string) => ICONS[`../assets/reactions/${SLUG[emoji.replace(/️/g, "")]}.svg`];

/** Color icon for a reaction emoji; older marks with no icon keep the glyph. */
export function ReactionIcon({ emoji, size, className }: { emoji: string; size: number; className?: string }) {
  const src = url(emoji);
  if (!src) return <span data-emoji={emoji} className={className}>{emoji}</span>;
  return <img data-emoji={emoji} src={src} alt="" aria-hidden draggable={false} className={cn("inline-block shrink-0", className)} style={{ width: size, height: size }} />;
}
