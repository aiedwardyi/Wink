import { catalogs } from "./i18n-catalog";

// Only these three open with the prompt already typed in, never sent. Gemini and Muse ignore it, so they stay copy-paste.
export const IMPORT_PROVIDERS = [
  { name: "ChatGPT", url: "https://chatgpt.com/?q=" },
  { name: "Claude", url: "https://claude.ai/new?q=" },
  { name: "Grok", url: "https://grok.com/?q=" },
] as const;

export const isImportPrompt = (code: string): boolean => code === catalogs.en["aboutYou.prompt"] || code === catalogs.ko["aboutYou.prompt"];

export const importLink = (provider: (typeof IMPORT_PROVIDERS)[number], prompt: string): string => provider.url + encodeURIComponent(prompt);
