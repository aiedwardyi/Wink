import type { ReactNode } from "react";

import { webLinks } from "@/lib/web-links";

/** A person's line stays plain text; only web links become links. */
export function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const link of webLinks(text)) {
    parts.push(text.slice(from, link.start));
    parts.push(<a key={link.start} href={link.href} target="_blank" rel="noreferrer" className="break-words text-accent underline decoration-accent/40 hover:decoration-accent">{link.text}</a>);
    from = link.start + link.text.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
