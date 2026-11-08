import { useSyncExternalStore } from "react";
import { VERIFY_ROUTES, verifyCardStale, type VerifyCardData, type VerifyCounts, type VerifyIssue, type VerifyTile } from "../../shared/live-verify";
import { request } from "@/lib/api-request";
import type { Message } from "@/state/store";

export interface VerifyWatchOpen {
  threadId: string;
  owner: string;
  messageId?: string;
  /** opened from Watch live, so the panel closes 3 s after the end */
  live: boolean;
}

let open: VerifyWatchOpen | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function openVerifyWatch(next: VerifyWatchOpen) {
  open = next;
  emit();
}

export function closeVerifyWatch() {
  if (!open) return;
  open = null;
  emit();
}

export function toggleVerifyWatch(next: VerifyWatchOpen) {
  if (open?.threadId === next.threadId) closeVerifyWatch();
  else openVerifyWatch(next);
}

export function useVerifyWatch(): VerifyWatchOpen | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => open, () => null);
}

export interface VerifyShowing {
  runId: string;
  checks: number;
  by: NonNullable<VerifyCounts["by"]>;
}

let showing: VerifyShowing | null = null;

export function setVerifyShowing(next: VerifyShowing | null) {
  if (!showing && !next) return;
  showing = next;
  emit();
}

/** The replay of this run while it plays, so the chat card can show its lanes for the same time. */
export function useVerifyShowing(runId: string): VerifyShowing | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => showing?.runId === runId ? showing : null, () => null);
}

let chosenTab: { runId: string; tile: VerifyTile } | null = null;

export function chooseVerifyTab(runId: string, tile: VerifyTile) {
  chosenTab = { runId, tile };
}

export function verifyChosenTab(runId: string): VerifyTile | null {
  return chosenTab?.runId === runId ? chosenTab.tile : null;
}

export function verifyCardIn(messages: readonly Message[], owner?: string, messageId?: string): VerifyCardData | undefined {
  return messages.findLast(message => message.kind === "note" && message.verify && (owner === undefined || message.verify.owner === owner) && (messageId === undefined || message.id === messageId))?.verify;
}

export function rerunVerify(card: VerifyCardData, threadId: string): Promise<unknown> {
  return request(VERIFY_ROUTES.decision.replace(":runId", encodeURIComponent(card.runId)), { method: "POST", body: JSON.stringify({ action: "rerun", nonce: card.decisionNonce, owner: card.owner, threadId }) });
}

export type VerifyCardAction = "live" | "watch" | "rerun" | null;

/** The card's one button. A phone gets Watch only after the end. */
export function verifyCardAction(card: VerifyCardData, phone: boolean, now = Date.now()): VerifyCardAction {
  const stale = verifyCardStale(card, now);
  const running = !stale && (card.status === "preparing" || card.status === "running");
  if (running) return card.live && !phone ? "live" : null;
  if (card.status === "waiting" && !stale) return null;
  return card.replay?.length ? "watch" : "rerun";
}

/** Live view only while the panel is open, its chat is shown and the window is on screen. */
export function verifyLiveGate(panelOpen: boolean, chatHidden: boolean, visibility: DocumentVisibilityState): boolean {
  return panelOpen && !chatHidden && visibility === "visible";
}

export const VERIFY_REEL_MAX = 5;

export function verifyReel(issues: readonly VerifyIssue[]): VerifyIssue[] {
  return issues.slice(0, VERIFY_REEL_MAX);
}

/** At the end the panel turns to the tab with problems, desktop first. */
export function verifyEndTab(issues: readonly VerifyIssue[]): VerifyTile {
  return issues.length && !issues.some(issue => issue.tile === "desktop") ? "phone" : "desktop";
}
