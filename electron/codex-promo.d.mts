export const CODEX_PROMO_MESSAGE: string;
export function isCodexPromo(failure: unknown): boolean;
export function codexPromoBlocked(home: string, generation?: number): boolean;
export function markCodexPromo(home: string, generation: number): void;
export function clearCodexPromo(home: string): void;
export function requireCodexPromoAccount(home: string, generation?: number): void;
export function codexPromoScreen(text: string, cols?: number): boolean;
