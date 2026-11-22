import { catalogs } from "./i18n-catalog.ts";

// Only these three open with the prompt already typed in, never sent. Gemini and Muse ignore it, so they stay copy-paste.
export const IMPORT_PROVIDERS = [
  { name: "ChatGPT", url: "https://chatgpt.com/?q=" },
  { name: "Claude", url: "https://claude.ai/new?q=" },
  { name: "Grok", url: "https://grok.com/?q=" },
] as const;

export const IMPORT_OFFER = {
  en: [
    "Want me to know what ChatGPT, Claude, Gemini, Grok or Muse already knows about you? It takes a minute:",
    "1. Copy the prompt in the box below.",
    "2. Paste it into that AI, on its own app or website (not here in Wink).",
    "3. Copy its answer and paste it back here.",
  ],
  ko: [
    "ChatGPT, Claude, Gemini, Grok, Muse가 이미 알고 있는 내용을 저도 알아 둘까요? 1분이면 돼요:",
    "1. 아래 상자의 프롬프트를 복사하세요.",
    "2. 그 AI의 앱이나 웹사이트에 붙여 넣으세요 (여기 Wink 말고요).",
    "3. 그 AI의 답을 복사해서 여기에 붙여 넣으세요.",
  ],
} as const;

export const isImportPrompt = (code: string): boolean => code === catalogs.en["aboutYou.prompt"] || code === catalogs.ko["aboutYou.prompt"];

export const importLink = (provider: (typeof IMPORT_PROVIDERS)[number], prompt: string): string => provider.url + encodeURIComponent(prompt);

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The block the offer note asks for: the offer word for word, then the prompt fenced as text. The prompt quoted anywhere else never matches.
const OFFER_BLOCK = new RegExp((["en", "ko"] as const).map((locale) => IMPORT_OFFER[locale].map(literal).join("\\s*\\n\\s*")
  + `\\s*\\n(?=\`\`\`text\\n${literal(catalogs[locale]["aboutYou.prompt"])}\\n\`\`\`)`).join("|"));

/** Where the offer's own prompt fence starts in a reply, or -1. */
export function importOfferFence(text: string): number {
  const match = OFFER_BLOCK.exec(text);
  return match ? match.index + match[0].length : -1;
}

type Row = { id: string; role: string; kind: string; text?: string; parentId?: string | null; importOffer?: true; steered?: boolean; quick?: object };

/** The stamped offer reply, only if the active path from the thread's root shows it answers the first typed message; a synced stamp anywhere else is ignored. */
export function importOfferId(transcript: readonly Row[]): string | undefined {
  if (transcript[0]?.parentId !== null) return undefined;
  let typed = 0;
  for (const row of transcript) {
    if (row.role === "user" && row.kind === "text" && !row.steered && !row.quick && ++typed > 1) return undefined;
    if (typed === 1 && row.importOffer && row.role === "bot" && row.kind === "text" && importOfferFence(row.text ?? "") >= 0) return row.id;
  }
  return undefined;
}
