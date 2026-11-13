const WEB_LINK = /https?:\/\/[^\s<>"`]+|(?<![\p{L}\p{N}_@./\\-])www\.[^\s<>"`]+/giu;

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
    const href = explicit ? value : `https://${value}`;
    try {
      new URL(href);
    } catch {
      continue;
    }
    links.push({ start: match.index, text: value, href });
  }
  return links;
}

