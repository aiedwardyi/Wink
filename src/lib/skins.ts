// Skins are pure CSS. Every one of them is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS.
import { useSyncExternalStore } from "react";
import monoHudCss from "@/skins/mono-hud.css?inline";
import toolSkinsCss from "@/skins/tool-skins.css?inline";
import type { MessageKey } from "./i18n-catalog";
import { trackSetting } from "./usage-stats";

export const SKIN_IDS = [
  "wink",
  "wink-cyber",
  "wink-violet",
  "wink-black",
  "wink-day",
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "ledger",
  "catppuccin-frappe",
  "tokyo-night",
  "vesper",
  "onyx",
  "peach",
  "coral",
  "dracula",
  "cobalt",
  "gruvbox",
  "kanagawa",
  "hurtado",
  "rose-pine",
  "nord",
  "github-dimmed",
  "tui",
  "tui-black",
  "tui-amber",
  "tui-ice",
  "tui-slate",
  "tui-smoke",
  "terminal",
  "terminal-dracula",
  "terminal-ice",
  "paper-tape",
  "logfile",
  "multiplexer",
  "modal",
  "vscode-dark",
  "studio-gray",
  "steel-gray",
  "claude",
  "precision",
  "mono-hud",
  "servo-gray",
  "notebook",
  "messenger",
  "community",
  "community-light",
  "code-review",
  "blueprint",
  "blueprint-gray",
  "blueprint-charcoal",
  "instrument",
  "matte",
  "carbon",
  "pewter",
  "pewter-dusk",
  "pewter-night",
  "coal",
  "folio",
  "inkwell",
  "graphite",
  "merlot",
  "precision-dimmed",
  "bronze",
  "dim-sand",
  "lagoon-night",
  "snow",
  "snow-night",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  nameKey?: MessageKey;
};

export const SKINS: readonly Skin[] = [
  { id: "wink", name: "Wink" },
  { id: "wink-cyber", name: "Wink Cyber" },
  { id: "wink-violet", name: "Wink Violet" },
  { id: "wink-black", name: "Wink Black" },
  { id: "wink-day", name: "Wink Day" },
  { id: "midnight", name: "Midnight" },
  { id: "atelier", name: "Atelier" },
  { id: "foundry", name: "Foundry" },
  { id: "lagoon", name: "Lagoon", nameKey: "settings.skin.lagoon" },
  { id: "ledger", name: "Ledger" },
  { id: "catppuccin-frappe", name: "Catppuccin Frappe" },
  { id: "tokyo-night", name: "Tokyo Night" },
  { id: "vesper", name: "Vesper" },
  { id: "onyx", name: "Onyx" },
  { id: "peach", name: "Peach" },
  { id: "coral", name: "Coral" },
  { id: "dracula", name: "Dracula" },
  { id: "cobalt", name: "Panda Syntax" },
  { id: "gruvbox", name: "Gruvbox" },
  { id: "kanagawa", name: "Kanagawa" },
  { id: "hurtado", name: "Hurtado" },
  { id: "rose-pine", name: "Rosé Pine" },
  { id: "nord", name: "Nord" },
  { id: "github-dimmed", name: "GitHub Dimmed" },
  { id: "tui", name: "TUI" },
  { id: "tui-black", name: "TUI Black" },
  { id: "tui-amber", name: "TUI Amber" },
  { id: "tui-ice", name: "TUI Ice" },
  { id: "tui-slate", name: "TUI Slate" },
  { id: "tui-smoke", name: "TUI Smoke" },
  { id: "terminal", name: "Terminal" },
  { id: "terminal-dracula", name: "Terminal Dracula" },
  { id: "terminal-ice", name: "Terminal Ice" },
  { id: "paper-tape", name: "Paper Tape" },
  { id: "logfile", name: "Logfile" },
  { id: "multiplexer", name: "Multiplexer" },
  { id: "modal", name: "Modal" },
  { id: "vscode-dark", name: "VS Code Dark" },
  { id: "studio-gray", name: "Studio Gray" },
  { id: "steel-gray", name: "Steel Gray" },
  { id: "claude", name: "Claude" },
  { id: "precision", name: "Precision" },
  { id: "mono-hud", name: "Servo" },
  { id: "servo-gray", name: "Servo Gray" },
  { id: "notebook", name: "Notebook" },
  { id: "messenger", name: "Messenger" },
  { id: "community", name: "Community" },
  { id: "community-light", name: "Community Light" },
  { id: "code-review", name: "Code Review" },
  { id: "blueprint", name: "Blueprint" },
  { id: "blueprint-gray", name: "Blueprint Gray" },
  { id: "blueprint-charcoal", name: "Blueprint Charcoal" },
  { id: "instrument", name: "Instrument" },
  { id: "matte", name: "Matte" },
  { id: "carbon", name: "Carbon" },
  { id: "pewter", name: "Pewter" },
  { id: "pewter-dusk", name: "Pewter Dusk" },
  { id: "pewter-night", name: "Pewter Night" },
  { id: "coal", name: "Coal" },
  { id: "folio", name: "Folio" },
  { id: "inkwell", name: "Inkwell" },
  { id: "graphite", name: "Graphite" },
  { id: "merlot", name: "Merlot" },
  { id: "precision-dimmed", name: "Precision Dimmed" },
  { id: "bronze", name: "Bronze" },
  { id: "dim-sand", name: "Dim Sand" },
  { id: "lagoon-night", name: "Lagoon Night", nameKey: "settings.skin.lagoonNight" },
  { id: "snow", name: "Snow", nameKey: "settings.skin.snow" },
  { id: "snow-night", name: "Snow Night", nameKey: "settings.skin.snowNight" },
];

/** Must match electron/skin-overlay.cjs; skins.test.ts pins it. */
export const LIGHT_SKIN_IDS: ReadonlySet<SkinId> = new Set<SkinId>([
  "atelier",
  "lagoon",
  "ledger",
  "notebook",
  "messenger",
  "community-light",
  "code-review",
  "blueprint",
  "wink-day",
  "paper-tape",
  "dim-sand",
  "snow",
]);

const TERMINAL_SKIN_IDS: ReadonlySet<SkinId> = new Set<SkinId>(["terminal", "terminal-dracula", "terminal-ice", "paper-tape", "logfile", "multiplexer", "modal"]);

export const isTerminalSkin = (id: SkinId): boolean => TERMINAL_SKIN_IDS.has(id);

const TUI_SKIN_IDS: ReadonlySet<SkinId> = new Set<SkinId>(["tui", "tui-black", "tui-amber", "tui-ice", "tui-slate", "tui-smoke"]);

export const isTerminalToolSkin = (id: SkinId): boolean => isTerminalSkin(id) || TUI_SKIN_IDS.has(id);

const TOOL_SKIN_IDS: ReadonlySet<SkinId> = new Set<SkinId>(["logfile", "multiplexer", "modal"]);
export const HUD_SKIN_IDS: ReadonlySet<SkinId> = new Set<SkinId>(["mono-hud", "servo-gray"]);

export const DEFAULT_SKIN: SkinId = "precision";

// Fired after applySkin() so anything showing the current skin elsewhere
// (SkinPicker's checkmark) can re-read dataset.skin instead of going stale.
export const SKIN_CHANGE_EVENT = "orbit-skin-change";

const KEY = "omb-skin";
const TRIED_KEY = "omb-skins-tried";

// The input is whatever localStorage handed back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from a renamed
// skin. The list is the schema.
function isSkinId(value: unknown): value is SkinId {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return SKIN_IDS.includes(value as SkinId);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    // A bare feature test, not a narrowing of parsed input: in a renderer
    // without storage the identifier is simply not defined.
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function nextSkin(current: SkinId): SkinId {
  // Same dark-then-light order the picker shows, as one loop.
  const order = [
    ...SKINS.filter((skin) => !LIGHT_SKIN_IDS.has(skin.id)),
    ...SKINS.filter((skin) => LIGHT_SKIN_IDS.has(skin.id)),
  ];
  const i = order.findIndex((skin) => skin.id === current);
  return order[(i + 1) % order.length].id;
}

export function readSkin(): SkinId {
  try {
    const stored = getStore()?.getItem(KEY);
    if (stored === "catppuccin-mocha") return "catppuccin-frappe";
    if (stored === "tui-commander") return "tui-slate";
    if (stored === "tui-vga") return "tui-smoke";
    if (stored === "moss") return "merlot";
    return isSkinId(stored) ? stored : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

export function readTriedSkins(): SkinId[] {
  try {
    const value: unknown = JSON.parse(getStore()?.getItem(TRIED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(isSkinId) : [];
  } catch {
    return [];
  }
}

/**
 * Point the document at a skin and remember it. Called once before the first
 * paint (main.tsx) and again on every change from the picker — a stamped
 * attribute rather than a class so it can never collide with Tailwind.
 */
export function applySkin(id: SkinId, via?: "hotkey"): void {
  trackSetting("skin", document.documentElement.dataset.skin, id, via, KEY);
  document.documentElement.dataset.skin = id;
  const kind = TOOL_SKIN_IDS.has(id) ? "tool" : HUD_SKIN_IDS.has(id) ? "mono-hud" : "";
  const extra = document.head.querySelector<HTMLElement>("style[data-skin-extra]");
  if (extra && extra.dataset.skinExtra !== kind) extra.remove();
  if (kind && extra?.dataset.skinExtra !== kind) {
    const style = document.createElement("style");
    style.dataset.skinExtra = kind;
    style.textContent = kind === "tool" ? toolSkinsCss : monoHudCss;
    document.head.append(style);
  }
  try {
    getStore()?.setItem(KEY, id);
    const tried = readTriedSkins();
    if (!tried.includes(id)) getStore()?.setItem(TRIED_KEY, JSON.stringify([...tried, id]));
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }
  // The one surface CSS cannot reach: on Windows the caption buttons sit in a
  // native overlay the main process paints. Left at the default it stays
  // Midnight-black on a light skin — the "black block in the top-right
  // corner". Best-effort: a browser tab or an older desktop
  // build has no bridge, and the skin still applies without it.
  try {
    void window.ogb?.applySkin?.(id)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
  window.dispatchEvent?.(new Event(SKIN_CHANGE_EVENT));
  if (isTerminalSkin(id)) {
    void fetch("/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ features: { toolDetailCapture: true } }),
    }).catch(() => undefined);
  }
}

function subscribeSkin(onChange: () => void) {
  window.addEventListener(SKIN_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(SKIN_CHANGE_EVENT, onChange);
}

// SAFETY: applySkin() is the only writer of the attribute, and it writes a SkinId.
const activeSkin = (): SkinId =>
  (typeof document !== "undefined" && (document.documentElement.dataset.skin as SkinId)) || readSkin();

/** For the rare skin that changes what renders, not only how it looks. */
export function useSkin(): SkinId {
  return useSyncExternalStore(subscribeSkin, activeSkin, activeSkin);
}
