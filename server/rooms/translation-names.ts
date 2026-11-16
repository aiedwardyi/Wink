import { createHash, randomBytes } from "node:crypto";

export function protectTranslationNames(text: string, names: readonly string[]) {
  const candidates = [...new Set(names.filter((name) => name.trim() && text.includes(name)))].sort((a, b) => b.length - a.length);
  const nonce = randomBytes(8).toString("hex");
  const held: Array<{ tag: string; name: string }> = [];
  const pattern = candidates.map((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `${/^[a-z0-9_]/i.test(name) ? "(?<![a-zA-Z0-9_])" : ""}${escaped}${/[a-z0-9_]$/i.test(name) ? "(?![a-zA-Z0-9_])" : ""}`;
  }).join("|");
  const marked = pattern ? text.replace(new RegExp(pattern, "g"), (name) => {
    const tag = `name_${nonce}_${held.length}`;
    held.push({ tag, name });
    return `<${tag}>${name}</${tag}>`;
  }) : text;
  return {
    text: marked,
    hasNames: held.length > 0,
    cacheKey: createHash("sha256").update(JSON.stringify(held.map(({ name }) => name))).digest("hex"),
    restore(translated: string): string {
      for (const { tag, name } of held) {
        const marker = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
        if (translated.match(marker)?.length !== 1) throw new Error("translation changed name markers");
        translated = translated.replace(marker, () => name);
      }
      if (translated.includes(`<name_${nonce}_`) || translated.includes(`</name_${nonce}_`)) throw new Error("translation changed name markers");
      return translated;
    },
  };
}
