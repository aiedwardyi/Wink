import { useSyncExternalStore, type ReactNode } from "react";
import { instances } from "./fixtures.mjs";
export type * from "../../src/state/store-types";
export { shownModelSelection, terminalAttentionKey, terminalAttentionForBot, terminalAttentionCount, configStatusFromFrame, visibleNotificationThread, autoSpeaks, shouldClearSelectedUnread } from "../../src/state/store-transforms";

const state = { instances: instances(), bots: [], groups: [], tasks: [], settings: {}, configStatuses: {}, selectedBotId: "mina" };
const subscribe = () => () => {};
const snapshot = () => state;
const dispatch = () => {};
const refreshInstances = async () => {};

export function useStore() {
  return { state: useSyncExternalStore(subscribe, snapshot), dispatch, refreshInstances };
}
export const useStoreDispatch = () => dispatch;
export const useOptionalStoreDispatch = () => dispatch;
export const useEngineLoginRefresh = () => {};
export const useStreaming = () => false;
export const visibleMessages = (bot: { messages: unknown[] }) => bot.messages;
export const previewMessages = visibleMessages;
export const openNotificationTarget = () => {};
export const formatTime = (at: number) => new Date(at).toLocaleTimeString();
export const formatDateTime = (at: number) => new Date(at).toLocaleString();
export const MASCOT_MOTION_MS = 8000;
export const MESSAGE_PAGE = 200;
export const StoreProvider = ({ children }: { children: ReactNode }) => children;
export const useMascotMotionExpiry = () => {};

export async function api(path: string) {
  if (path.startsWith("/api/usage/")) return { status: "no_observation" };
  if (path === "/api/instances") return { instances: state.instances };
  return {};
}
