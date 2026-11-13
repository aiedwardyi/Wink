import { topLevelDomains } from "./top-level-domains";

const WEB_LINK = /https?:\/\/[^\s<>"`]+|(?<![\p{L}\p{N}_@./\\-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?::\d{1,5})?(?:[/?#][^\s<>"`]+)?/giu;

function trimLink(value: string): string {
  let text = value.replace(/[.,;:!?']+$/, "");
  const balance: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (const char of text) {
    if (pairs[char]) balance[pairs[char]]++;
    else if (char in balance) balance[char]--;
  }
  while (balance[text.at(-1)!] < 0) {
    balance[text.at(-1)!]++;
    text = text.slice(0, -1);
  }
  return text.replace(/[.,;:!?']+$/, "");
}

export function webLinks(text: string): Array<{ start: number; text: string; href: string }> {
  const links: Array<{ start: number; text: string; href: string }> = [];
  for (const match of text.matchAll(WEB_LINK)) {
    const value = trimLink(match[0]);
    const explicit = /^https?:\/\//i.test(value);
    if (!explicit && /^(?:[\p{L}\p{N}_@-]|\.[\p{L}\p{N}_-])/u.test(text.slice(match.index + match[0].length))) continue;
    const href = explicit ? value : `https://${value}`;
    try {
      const host = new URL(href).hostname;
      if (!explicit && !topLevelDomains.has(host.split(".").at(-1)!)) continue;
    } catch {
      continue;
    }
    links.push({ start: match.index, text: value, href });
  }
  return links;
}

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

export function remarkWebLinks() {
  const walk = (node: MdNode): void => {
    if (!node.children || ["link", "linkReference", "image", "imageReference"].includes(node.type)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text" || !child.value) {
        walk(child);
        return [child];
      }
      const parts: MdNode[] = [];
      let from = 0;
      for (const link of webLinks(child.value)) {
        parts.push({ type: "text", value: child.value.slice(from, link.start) });
        parts.push({ type: "link", url: link.href, children: [{ type: "text", value: link.text }] });
        from = link.start + link.text.length;
      }
      if (!parts.length) return [child];
      parts.push({ type: "text", value: child.value.slice(from) });
      return parts;
    });
  };
  return walk;
}
