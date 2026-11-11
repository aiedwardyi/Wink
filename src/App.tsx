import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Menu } from "lucide-react";
import {
  StoreProvider,
  api,
  openNotificationTarget,
  terminalAttentionForBot,
  terminalAttentionCount,
  terminalAttentionKey,
  useStore,
  visibleMessages,
  visibleNotificationThread,
  type Bot,
  type Group,
  type TerminalAttention,
} from "@/state/store";
import { collapsedUnreadCount, formatCollapsedUnreadBadge, unreadConversationCount } from "@/lib/unread";
import { anyChatNeedsYou } from "@/lib/open-question";
import { anyRoutineRinging, routineChatOnScreen } from "@/lib/routine-ring";
import { useArrivalGlow } from "@/lib/arrival-glow";
import { listedGroups, preferredStartupSelectionId } from "@/lib/sidebar-order";
import { DRAWER_BUTTON_LEFT, DRAWER_BUTTON_RIGHT } from "@/lib/drawer-button";
import { loadSidebarOrder, useSidebarSide } from "@/lib/sidebar-preferences";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { JoinedRoomView } from "@/components/JoinedRoomView";
import { TeamRoomView } from "@/components/TeamRoomView";
import { isTeamRoom, joinedRoomIdOf } from "@/lib/team-rooms";
import { useJoinedRooms } from "@/lib/joined-rooms";
import { UpdateBanner } from "@/components/UpdateBanner";
import { GlobalTooltip } from "@/components/GlobalTooltip";
import { LazyView } from "@/components/LazyView";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { isEmptyEngineLaunch } from "@/lib/engine-rail";
import { I18nProvider, useI18n } from "@/lib/i18n";
import { closeVerifyWatch, useVerifyWatch, verifyCardIn } from "@/lib/verify-watch";
import { useRightSlot, type SlotPanel } from "@/lib/right-slot";
import { LIVE_VERIFY_V0 } from "../shared/live-verify";
import { buildTerminalNotification, showNotification, type NotificationTarget } from "@/lib/notify";
import { terminalPopupsEnabled } from "@/lib/terminal-popups";
import { altDigitSelectsPane, backquoteTogglesTerminal, workerPaneOrder } from "@/lib/terminal-hotkeys";
import { workerRuns } from "@/lib/worker-runs";
import { useTerminalPanes } from "@/lib/terminal-panes";
import { rememberTerminalOpened, schedulePrestart } from "@/lib/terminal-prestart";
import { useWebTerminalBridge } from "@/lib/web-terminal-bridge";
import { composerNeedsTap, focusComposerOnActivation } from "@/lib/focus-composer";
import { webPushSupported, webPushTarget } from "@/lib/web-push";
import { closeReadAlerts } from "@/lib/read-alerts";
import { useDrawerSwipe, useIsPhone, usePhoneSwipe } from "@/lib/use-phone-swipe";
import { BackNavigation, backDepth, followSelection, trailTarget, type BackLayer } from "@/lib/back-navigation";
import { SKINS, applySkin, nextSkin, readSkin, type SkinId } from "@/lib/skins";
import { Presence, usePresence } from "@/lib/use-presence";
import { lazyView, useStaleBuildReload } from "@/lib/stale-build";
import { warmViews } from "@/lib/warm-views";
import { markColdOpen, noteCacheShown, noteChatShown, startWarmOpenTiming } from "@/lib/cold-open-timing";
import { startIdleMotion } from "@/lib/idle-motion";
import { useMonoHud } from "@/lib/use-mono-hud";

const Onboarding = lazyView(() => import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })));
const SettingsPanel = lazyView(() => import("@/components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const PluginsPanel = lazyView(() => import("@/components/PluginsPanel").then((m) => ({ default: m.PluginsPanel })));
const InspectorPanel = lazyView(() => import("@/components/InspectorPanel").then((m) => ({ default: m.InspectorPanel })));
const SettingsModal = lazyView(() => import("@/components/SettingsModal").then((m) => ({ default: m.SettingsModal })));
const NoEngines = lazyView(() => import("@/components/NoEngines").then((m) => ({ default: m.NoEngines })));
const CommandPalette = lazyView(() => import("@/components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const CreateBotSheet = lazyView(() => import("@/components/CreateBotSheet").then((m) => ({ default: m.CreateBotSheet })));
const VerifyWatchPanel = lazyView(() => import("@/components/VerifyWatch").then((m) => ({ default: m.VerifyWatchPanel })));
const TerminalWorkspace = lazyView(() => import("@/components/TerminalWorkspace").then((m) => ({ default: m.TerminalWorkspace })));
const RemoteTerminalView = lazyView(() => import("@/components/RemoteTerminalView").then((m) => ({ default: m.RemoteTerminalView })));

function BootFallback({
  label,
  hint,
}: {
  label?: string;
  hint?: ReactNode;
}) {
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
      <Loader2 size={20} className="animate-spin" />
      {label ? <div className="text-[14px]">{label}</div> : null}
      {hint ? <div className="text-[12px]">{hint}</div> : null}
    </main>
  );
}

/** Selecting a bot that no longer exists falls back to the sidebar's own
 * first item, never raw server creation order. */
function fallbackStartupBot(bots: Bot[], groups: Group[]): Bot | undefined {
  const id = preferredStartupSelectionId(bots, groups, loadSidebarOrder());
  return bots.find((b) => b.id === id) ?? bots[0];
}

function Shell({ onboardingOpen }: { onboardingOpen: boolean }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const latestState = useRef(state);
  const handledTerminalAttention = useRef(new Set<string>());
  const pendingTerminalAcknowledgements = useRef(new Map<string, Set<string>>());
  useLayoutEffect(() => {
    latestState.current = state;
  }, [state]);
  const joinedRooms = useJoinedRooms();
  const unreadCount = unreadConversationCount(state.bots, state.groups, joinedRooms) + terminalAttentionCount(state.terminalAttention);
  const menuUnreadBadge = formatCollapsedUnreadBadge(collapsedUnreadCount(state.bots, state.groups, state.selectedId, joinedRooms));
  const menuChats = [...state.bots, ...listedGroups(state.groups)];
  const menuExceptId = routineChatOnScreen(state) ? state.selectedId : undefined;
  const menuQuestion = anyChatNeedsYou(menuChats, menuExceptId);
  const menuRoutine = anyRoutineRinging(state.routineRuns, menuChats, menuExceptId);
  const menuAsking = menuQuestion || menuRoutine;
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The button is md:hidden: at desktop width its animation never runs, so an
  // ungated glow would sit flagged until a later resize replays it. Gating on
  // visibility consumes the arrival instead.
  const phoneMenuVisible = useIsPhone();
  const menuArrival = useArrivalGlow(
    [...state.bots.filter((bot) => !bot.hidden), ...listedGroups(state.groups)]
      .filter((chat) => chat.id !== state.selectedId)
      .map((chat) => chat.id),
    { enabled: !drawerOpen && phoneMenuVisible, asking: menuAsking },
  );
  const [themeToast, setThemeToast] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [messageMenuOpen, setMessageMenuOpen] = useState(false);
  const [backLayers, setBackLayers] = useState<BackLayer[]>([]);
  const [sidebarOverlay, setSidebarOverlay] = useState<string | null>(null);
  const modelPickerIds = useRef(new Set<string>());
  const [terminalViews, setTerminalViews] = useState<Record<string, boolean>>({});
  const [paneFocus, setPaneFocus] = useState<{ sessionId: string | null; botId?: string } | null>(null);
  const paneRequest = useRef(0);
  const shownPaneOrder = useRef<{ botId: string; order: string[] } | null>(null);
  const onPaneOrder = useCallback((botId: string, order: string[] | null) => {
    if (order) shownPaneOrder.current = { botId, order };
    else if (shownPaneOrder.current?.botId === botId) shownPaneOrder.current = null;
  }, []);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarOnRight = useSidebarSide() === "right";
  const conversationRef = useRef<HTMLDivElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const joinedId = joinedRoomIdOf(state.selectedId);
  const bot = group || joinedId ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? fallbackStartupBot(state.bots, state.groups));
  useMonoHud(bot, state.instances);
  const terminalOpen = Boolean(bot && terminalViews[bot.id]);
  const webTerminal = useWebTerminalBridge(bot?.id, state.config?.features?.terminalLive === true, terminalOpen);
  // stable: a fresh one re-renders the whole transcript on every chat and terminal switch
  const botId = bot?.id;
  const openTerminal = useCallback(() => { if (botId) setTerminalViews((views) => ({ ...views, [botId]: true })); }, [botId]);
  const openTerminalPane = useCallback((sessionId: string) => {
    openTerminal();
    if (botId) setPaneFocus({ sessionId, botId });
  }, [botId, openTerminal]);
  const openMainTerminal = useCallback(() => {
    openTerminal();
    if (botId) setPaneFocus({ sessionId: null, botId });
  }, [botId, openTerminal]);
  const botPaneFocus = paneFocus?.botId && paneFocus.botId !== botId ? null : paneFocus;
  useEffect(() => {
    setPaneFocus((focus) => focus?.botId && focus.botId !== botId ? null : focus);
  }, [botId]);
  const clearTerminalAttention = (attention: Pick<TerminalAttention, "botId" | "sessionId">) => {
    const key = terminalAttentionKey(attention.botId, attention.sessionId);
    const sessions = pendingTerminalAcknowledgements.current.get(attention.botId);
    sessions?.delete(attention.sessionId);
    if (sessions?.size === 0) pendingTerminalAcknowledgements.current.delete(attention.botId);
    handledTerminalAttention.current.delete(key);
    dispatch({ type: "ackTerminalAttention", botId: attention.botId, sessionId: attention.sessionId });
  };
  const acknowledgeTerminalAttention = (attention: Pick<TerminalAttention, "botId" | "sessionId">) => {
    clearTerminalAttention(attention);
    const acknowledge = window.ogb?.terminal?.acknowledge;
    if (acknowledge) void acknowledge(attention.sessionId).catch(() => {});
  };
  const requestTerminalAcknowledgement = (attention: Pick<TerminalAttention, "botId" | "sessionId">) => {
    const sessions = pendingTerminalAcknowledgements.current.get(attention.botId) ?? new Set<string>();
    sessions.add(attention.sessionId);
    pendingTerminalAcknowledgements.current.set(attention.botId, sessions);
    if (terminalOpen && bot?.id === attention.botId && document.hasFocus()) acknowledgeTerminalAttention(attention);
  };
  const openTerminalNotification = (target: NotificationTarget) => {
    openNotificationTarget(dispatch, target, latestState.current);
    if (target.openTerminal) setTerminalViews((views) => ({ ...views, [target.botId]: true }));
    if (target.openTerminal && target.terminalSessionId) setPaneFocus({ sessionId: target.terminalSessionId });
    if (target.openTerminal) {
      const attention = target.terminalSessionId
        ? { botId: target.botId, sessionId: target.terminalSessionId }
        : terminalAttentionForBot(latestState.current.terminalAttention, target.botId);
      if (attention) requestTerminalAcknowledgement(attention);
    }
  };
  const openTerminalAttention = (attention: TerminalAttention) => {
    const current = latestState.current;
    const target = current.bots.find((candidate) => candidate.id === attention.botId);
    if (!target) {
      acknowledgeTerminalAttention(attention);
      return;
    }
    openNotificationTarget(
      dispatch,
      { botId: attention.botId, threadId: target.threadId, openTerminal: true },
      current,
    );
    setTerminalViews((views) => ({ ...views, [attention.botId]: true }));
    setPaneFocus({ sessionId: attention.sessionId });
    requestTerminalAcknowledgement(attention);
  };

  useEffect(() => {
    const acknowledgeVisible = () => {
      if (!terminalOpen || !bot || !document.hasFocus()) return;
      const targeted = pendingTerminalAcknowledgements.current.get(bot.id);
      if (targeted) {
        for (const sessionId of [...targeted]) {
          const attention = state.terminalAttention[terminalAttentionKey(bot.id, sessionId)];
          if (attention) acknowledgeTerminalAttention(attention);
          else targeted.delete(sessionId);
        }
        if (targeted.size === 0) pendingTerminalAcknowledgements.current.delete(bot.id);
        return;
      }
      const attention = terminalAttentionForBot(state.terminalAttention, bot.id);
      if (attention) acknowledgeTerminalAttention(attention);
    };
    acknowledgeVisible();
    window.addEventListener("focus", acknowledgeVisible);
    return () => window.removeEventListener("focus", acknowledgeVisible);
  }, [bot?.id, state.terminalAttention, terminalOpen, dispatch]);

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count: that CLI can still host a local model. An empty list means the
  // first /api/instances response has not arrived yet.
  const noEngines = state.connected && isEmptyEngineLaunch(state.instances);

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.inspectorOpen ||
    state.appSettingsOpen ||
    state.pluginsOpen ||
    state.createBotOpen;
  const watch = useVerifyWatch();
  const watchChat = group ?? bot;
  const watchCard = LIVE_VERIFY_V0 && watch && watchChat && watch.threadId === watchChat.threadId && !phoneMenuVisible
    ? verifyCardIn(group ? group.messages : visibleMessages(bot!), watch.owner, watch.messageId)
    : undefined;
  const watchShown = usePresence(watch && watchChat && watchCard ? { card: watchCard, threadId: watchChat.threadId, live: watch.live } : null);
  const watchDock = watchShown.mounted ? " verify-watch-dock" : "";
  const slotPanels: SlotPanel[] = [...(watch ? ["watch" as const] : []), ...(state.settingsOpen ? ["details" as const] : []), ...(state.inspectorOpen ? ["inspector" as const] : [])];
  const closeSlot = (panel: SlotPanel) => panel === "watch" ? closeVerifyWatch() : dispatch({ type: panel === "details" ? "toggleSettings" : "toggleInspector", open: false });
  useRightSlot(slotPanels, closeSlot);
  useEffect(() => closeVerifyWatch(), [state.selectedId]);
  const slotShown = !phoneMenuVisible && Boolean(watchShown.value && !watchShown.closing || bot && (state.settingsOpen || state.inspectorOpen));
  const watchPanel = (hidden: boolean) => watchShown.value && (
    <LazyView>
      <VerifyWatchPanel {...watchShown.value} hidden={hidden} closing={watchShown.closing} />
    </LazyView>
  );

  // App-wide shortcuts: Alt+T Themes · Alt+Shift+T Cycle theme · Alt+U Usage · Alt+I Model index · Alt+W Workers · Ctrl+1..9 Nth bot · Alt+1..9 Nth worker pane. Esc still closes panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("[data-media-viewer]")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.altKey && !mod && !e.shiftKey && e.code === "KeyI") {
        e.preventDefault();
        e.stopPropagation();
        dispatch({
          type: "toggleAppSettings",
          open: !(state.appSettingsOpen && state.appSettingsSection === "models-index"),
          section: "models-index",
        });
        return;
      }
      if (e.altKey && !mod && e.shiftKey && e.code === "KeyT") {
        if (e.repeat || e.isComposing) return;
        e.preventDefault();
        const current = (document.documentElement.dataset.skin as SkinId) || readSkin();
        const next = nextSkin(current);
        applySkin(next);
        setThemeToast(SKINS.find((skin) => skin.id === next)?.name ?? next);
        return;
      }
      if (e.altKey && !mod && !e.shiftKey) {
        if (e.code === "KeyW") {
          if (nativeViewOverlayOpen || onboardingOpen || e.repeat || e.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new Event("orbit:toggle-worker-menu"));
          return;
        }
        if (e.code === "KeyT") {
          e.preventDefault();
          dispatch({
            type: "toggleAppSettings",
            open: !(state.appSettingsOpen && state.appSettingsSection === "themes"),
            section: "themes",
          });
          return;
        }
        if (e.code === "KeyU") {
          if (e.repeat || e.isComposing) return;
          const usageOpen = state.appSettingsOpen && state.appSettingsSection === "usage";
          if (!usageOpen && (onboardingOpen || (nativeViewOverlayOpen && !state.appSettingsOpen))) return;
          e.preventDefault();
          // A chat's usage line takes the first press for its quick view; the next reaches all Usage.
          if (!state.appSettingsOpen && !window.dispatchEvent(new CustomEvent("orbit:usage-key", { cancelable: true }))) return;
          dispatch({ type: "toggleAppSettings", open: !usageOpen, section: "usage" });
          return;
        }
      }
      if (!e.shiftKey && ((e.altKey && !mod) || (e.ctrlKey && !e.metaKey && !e.altKey))) {
        const n: number | null =
          e.code === "Digit1" || e.code === "Numpad1" ? 1
          : e.code === "Digit2" || e.code === "Numpad2" ? 2
          : e.code === "Digit3" || e.code === "Numpad3" ? 3
          : e.code === "Digit4" || e.code === "Numpad4" ? 4
          : e.code === "Digit5" || e.code === "Numpad5" ? 5
          : e.code === "Digit6" || e.code === "Numpad6" ? 6
          : e.code === "Digit7" || e.code === "Numpad7" ? 7
          : e.code === "Digit8" || e.code === "Numpad8" ? 8
          : e.code === "Digit9" || e.code === "Numpad9" ? 9
          : null;
        if (n !== null && e.altKey) {
          if (!altDigitSelectsPane(Boolean(window.ogb?.terminal), !window.ogb) || !bot || group || nativeViewOverlayOpen || onboardingOpen) return;
          e.preventDefault();
          e.stopPropagation();
          const request = ++paneRequest.current;
          const shown = shownPaneOrder.current;
          if (shown?.botId === bot.id) {
            const sessionId = shown.order[n - 1];
            if (sessionId) openTerminalPane(sessionId);
            return;
          }
          const roster = window.ogb?.terminal
            ? window.ogb.terminal.readBot?.(bot.id)
            : api(`/api/bots/${encodeURIComponent(bot.id)}/terminal`);
          void roster?.then((snapshot) => {
            if (request !== paneRequest.current || latestState.current.selectedId !== bot.id) return;
            const sessionId = workerPaneOrder(snapshot?.panes ?? [], workerRuns(visibleMessages(bot)))[n - 1];
            if (sessionId) openTerminalPane(sessionId);
          }).catch(() => {});
          return;
        }
        if (n !== null) {
          const rows = document.querySelectorAll('[data-sidebar-row-kind="bot"]');
          const id = rows[n - 1]?.getAttribute("data-sidebar-row-id");
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          dispatch({ type: "select", id });
          focusComposerOnActivation({ settingsOpen: state.appSettingsOpen || state.settingsOpen });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state.appSettingsOpen, state.appSettingsSection, state.settingsOpen, bot, group, openTerminalPane, nativeViewOverlayOpen, onboardingOpen, dispatch]);

  useEffect(() => {
    if (!themeToast) return;
    const timer = window.setTimeout(() => setThemeToast(null), 1200);
    return () => window.clearTimeout(timer);
  }, [themeToast]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  // Desktop boot parks API calls on every free connection until the server is up, so a gear click could not fetch this.
  useEffect(() => {
    if (window.ogb) void import("@/components/SettingsModal").catch(() => {});
  }, []);

  useEffect(() => {
    if (state.hydrated) return warmViews([SettingsPanel.preload, SettingsModal.preload]);
  }, [state.hydrated]);

  useEffect(() => {
    const offAttention = window.ogb?.terminal?.onAttention?.(({ id: sessionId, botId, reason }) => {
      const current = latestState.current;
      const bot = current.bots.find((candidate) => candidate.id === botId);
      if (!bot) return;
      const key = terminalAttentionKey(botId, sessionId);
      if (handledTerminalAttention.current.has(key) || current.terminalAttention[key]) return;
      handledTerminalAttention.current.add(key);
      dispatch({ type: "markTerminalAttention", botId, sessionId, reason, receivedAt: Date.now() });
      if (!terminalPopupsEnabled()) return;
      const frame = buildTerminalNotification(bot, reason, sessionId);
      if (!frame) return;
      showNotification(
        frame,
        openTerminalNotification,
        terminalOpen && current.selectedId === botId ? visibleNotificationThread(current) : null,
      );
    });
    return offAttention;
  }, [dispatch, terminalOpen]);

  useEffect(() => {
    const offClosed = window.ogb?.terminal?.onClosed?.(({ id: sessionId, botId }) => {
      const current = latestState.current;
      if (!current.terminalAttention[terminalAttentionKey(botId, sessionId)]) return;
      clearTerminalAttention({ botId, sessionId });
    });
    return offClosed;
  }, [dispatch]);

  useTerminalPanes(dispatch, terminalOpen);

  useEffect(() => {
    return window.ogb?.onNotificationClick?.((target) => {
      window.focus();
      const current = latestState.current;
      openNotificationTarget(dispatch, target, current);
      if (target.openTerminal) {
        setTerminalViews((views) => ({ ...views, [target.botId]: true }));
        if (target.terminalSessionId) setPaneFocus({ sessionId: target.terminalSessionId });
        const attention = target.terminalSessionId
          ? { botId: target.botId, sessionId: target.terminalSessionId }
          : terminalAttentionForBot(current.terminalAttention, target.botId);
        if (attention) requestTerminalAcknowledgement(attention);
      } else {
        // A chat toast must not inherit the bot's last terminal view.
        setTerminalViews((views) => ({ ...views, [target.botId]: false }));
      }
    });
  }, [dispatch]);

  // A tapped push notification: its /?bot=&thread= url on a cold open, or a worker message when already open.
  const pushOpenTarget = useRef(webPushTarget(window.location.search));
  const hydratedBots = state.bots.length > 0;
  useEffect(() => {
    const target = pushOpenTarget.current;
    if (!target || !hydratedBots) return;
    pushOpenTarget.current = null;
    window.history.replaceState(window.history.state, "", window.location.pathname);
    openNotificationTarget(dispatch, target, latestState.current, true);
  }, [dispatch, hydratedBots]);
  useEffect(() => {
    const worker = window.ogb ? undefined : navigator.serviceWorker;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "orbit-push") {
        void closeReadAlerts(() => [...latestState.current.bots, ...latestState.current.groups]).catch(() => {});
        return;
      }
      if (event.data?.type !== "orbit-open" || typeof event.data.url !== "string") return;
      const target = webPushTarget(new URL(event.data.url, window.location.origin).search);
      if (!target) return;
      setTerminalViews((views) => ({ ...views, [target.botId]: false }));
      startWarmOpenTiming(Number(event.data.t0), target.threadId);
      openNotificationTarget(dispatch, target, latestState.current);
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, [dispatch]);
  const readChats = [...state.bots, ...state.groups].map((chat) => (chat.unread ? "" : `${chat.id}:${chat.readAt}`)).join(" ");
  useEffect(() => {
    if (webPushSupported()) void closeReadAlerts(() => [...latestState.current.bots, ...latestState.current.groups]).catch(() => {});
  }, [readChats]);
  // Reads on other devices show up here: no silent push, since Chrome bills each one and then shows its own alert.
  useEffect(() => {
    if (!webPushSupported()) return;
    const sweep = () => {
      if (document.visibilityState !== "visible") return;
      void closeReadAlerts(async () => {
        const { bots, groups } = await api("/api/bots?messages=0");
        return [...bots, ...groups];
      }).catch(() => {});
    };
    sweep();
    document.addEventListener("visibilitychange", sweep);
    return () => document.removeEventListener("visibilitychange", sweep);
  }, []);
  const shown = group ?? bot;
  const shownThread = state.hydrated && shown?.messages?.length ? shown.threadId : undefined;
  // No deps: a warm tap onto the chat already on screen changes nothing here but still needs its paint time.
  useEffect(() => noteChatShown(shownThread));
  const cachedThread = !state.hydrated && shown?.messages?.length ? shown.threadId : undefined;
  useEffect(() => noteCacheShown(cachedThread));

  const taskbarBusy = state.bots.some((candidate) => candidate.busy);
  useEffect(() => {
    window.ogb?.setTaskbarBusy?.(taskbarBusy);
  }, [taskbarBusy]);

  // Warm connected-account state after first paint. The catalog is not on
  // the chat path; pulling PluginsPanel into the initial module graph (or
  // hitting /api/connectors/connected during hydrate) delays the composer.
  useEffect(() => {
    if (!state.connected) return;
    let cancelled = false;
    const wake = () => {
      if (cancelled) return;
      void import("@/components/PluginsPanel")
        .then((m) => m.preloadConnectedApps())
        .catch(() => {});
    };
    const idle = window.requestIdleCallback?.(wake, { timeout: 800 });
    const timer = idle == null ? window.setTimeout(wake, 1) : 0;
    return () => {
      cancelled = true;
      if (idle != null) window.cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, [state.connected]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.pluginsOpen, state.settingsOpen, state.appSettingsOpen]);

  // the workspace paints before a passive effect would run, and an unread frame
  // landing in that gap would clear a badge for a chat nobody can see
  useLayoutEffect(() => {
    dispatch({ type: "setWorkspaceOpen", open: terminalOpen });
  }, [terminalOpen, dispatch]);

  const botsUnreadable = state.botsUnreadable && state.bots.length === 0;
  const createBotRequired = !noEngines && state.bots.length === 0 && !botsUnreadable;
  const createBotSheetOpen = !onboardingOpen && state.connected && state.hydrated && (state.createBotOpen || createBotRequired);
  const secondaryViewOpen =
    onboardingOpen ||
    terminalOpen ||
    paletteOpen ||
    Boolean(sidebarOverlay) ||
    state.appSettingsOpen ||
    state.pluginsOpen ||
    createBotSheetOpen ||
    Boolean(bot && (state.settingsOpen || state.inspectorOpen));
  useStaleBuildReload(state.connected, secondaryViewOpen);

  const swipeStageRef = usePhoneSwipe(bot?.id, !terminalOpen && !nativeViewOverlayOpen, (id) => dispatch({ type: "select", id }), menuButtonRef);
  const closeDrawer = () => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  };
  const drawerShellRef = useDrawerSwipe(drawerOpen && !sidebarOverlay, sidebarOnRight ? "right" : "left", closeDrawer);

  const chatShown = Boolean(bot && !terminalOpen);
  useEffect(() => {
    if (bot && terminalOpen) rememberTerminalOpened(bot.id);
  }, [bot?.id, terminalOpen]);
  useEffect(() => {
    if (!bot || !chatShown) return;
    return schedulePrestart({
      bridge: window.ogb?.terminal,
      botId: bot.id,
      projectCwd: bot.cwd ?? null,
      measure: () => conversationRef.current?.getBoundingClientRect(),
    });
  }, [bot?.id, bot?.cwd, chatShown]);

  const closeTerminal = () => {
    paneRequest.current++;
    if (bot) setTerminalViews((views) => ({ ...views, [bot.id]: false }));
    requestAnimationFrame(() => {
      if (!composerNeedsTap()) conversationRef.current?.querySelector<HTMLTextAreaElement>("[data-orbit-composer]")?.focus();
    });
  };

  const backNavigation = useRef<BackNavigation | null>(null);
  const selectionTrail = useRef<string[]>([]);
  // insertion order is open order, so Back closes the newest overlay first
  const openedLayers = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (window.ogb) return;
    const navigation = new BackNavigation(window.history);
    backNavigation.current = navigation;
    const onPop = (event: PopStateEvent) => navigation.pop(backDepth(event.state));
    const onPicker = (event: Event) => {
      const { id, open } = (event as CustomEvent<{ id: string; open: boolean }>).detail;
      if (open) modelPickerIds.current.add(id);
      else modelPickerIds.current.delete(id);
      setModelPickerOpen(modelPickerIds.current.size > 0);
    };
    const onMessageMenu = (event: CustomEvent<boolean>) => setMessageMenuOpen(event.detail);
    const onLayer = (event: WindowEventMap["orbit:back-layer"]) => {
      const { key, close } = event.detail;
      setBackLayers((current) => {
        const kept = current.filter((layer) => layer.key !== key);
        return close ? [...kept, { key, close }] : kept;
      });
    };
    const onLeave = (event: CustomEvent<string>) => navigation.leave(() => window.location.replace(event.detail));
    window.addEventListener("popstate", onPop);
    window.addEventListener("orbit:model-picker", onPicker);
    window.addEventListener("orbit:message-menu", onMessageMenu);
    window.addEventListener("orbit:back-layer", onLayer);
    window.addEventListener("orbit:leave", onLeave);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("orbit:model-picker", onPicker);
      window.removeEventListener("orbit:message-menu", onMessageMenu);
      window.removeEventListener("orbit:back-layer", onLayer);
      window.removeEventListener("orbit:leave", onLeave);
      backNavigation.current = null;
    };
  }, []);

  useEffect(() => {
    if (!backNavigation.current) return;
    const root = state.bots.find((candidate) => candidate.chiefOfStaff)?.id ?? state.bots[0]?.id;
    const trail = selectionTrail.current;
    const exists = (id: string) =>
      latestState.current.bots.some((candidate) => candidate.id === id) || latestState.current.groups.some((candidate) => candidate.id === id);
    if (root) followSelection(trail, root, state.selectedId, exists);
    else trail.length = 0;
    const chats: BackLayer[] = trail.slice(1).map((id, index) => ({
      key: `chat:${id}`,
      close: () => {
        const target = trailTarget(trail, index, exists);
        if (target) dispatch({ type: "select", id: target });
      },
    }));
    const layers: BackLayer[] = [];
    const add = (open: boolean, key: string, close: () => void) => { if (open) layers.push({ key, close }); };
    add(terminalOpen, `terminal:${bot?.id}`, closeTerminal);
    add(drawerOpen, "drawer", () => setDrawerOpen(false));
    add(Boolean(sidebarOverlay), `sidebar:${sidebarOverlay}`, () => window.dispatchEvent(new Event("orbit:close-sidebar-overlay")));
    add(state.settingsOpen, "settings", () => dispatch({ type: "toggleSettings", open: false }));
    add(state.inspectorOpen, "inspector", () => dispatch({ type: "toggleInspector", open: false }));
    add(state.appSettingsOpen, "app-settings", () => dispatch({ type: "toggleAppSettings", open: false }));
    add(state.pluginsOpen, "plugins", () => dispatch({ type: "togglePlugins", open: false }));
    add(state.createBotOpen, "create-bot", () => dispatch({ type: "closeCreateBot" }));
    add(paletteOpen, "palette", () => window.dispatchEvent(new Event("orbit:close-palette")));
    add(modelPickerOpen, "model-picker", () => window.dispatchEvent(new Event("orbit:close-model-picker")));
    add(messageMenuOpen, "message-menu", () => window.dispatchEvent(new Event("orbit:close-message-menu")));
    layers.push(...backLayers);
    const opened = openedLayers.current;
    const live = new Map(layers.map((layer) => [layer.key, layer]));
    for (const key of opened) if (!live.has(key)) opened.delete(key);
    for (const key of live.keys()) opened.add(key);
    backNavigation.current.sync([...chats, ...[...opened].map((key) => live.get(key)!)]);
  });

  useEffect(() => {
    const toggleTerminal = (event: KeyboardEvent) => {
      if (document.querySelector("[data-media-viewer]")) return;
      if (event.repeat || event.isComposing) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== "Backquote") return;
      if (!backquoteTogglesTerminal(Boolean(window.ogb), Boolean(window.ogb?.terminal)) || !bot || group || nativeViewOverlayOpen) return;
      event.preventDefault();
      event.stopPropagation();
      if (terminalOpen) closeTerminal();
      else openTerminal();
    };
    window.addEventListener("keydown", toggleTerminal, true);
    return () => window.removeEventListener("keydown", toggleTerminal, true);
  }, [bot?.id, group?.id, nativeViewOverlayOpen, terminalOpen]);

  // ChatView stays mounted under the terminal and across bot switches, so its header menus are told to close.
  useEffect(() => {
    window.dispatchEvent(new Event("orbit:close-worker-menu"));
    window.dispatchEvent(new Event("orbit:close-model-picker"));
  }, [terminalOpen, state.selectedId]);

  return (
    <div className="flex h-full flex-col">
      {/* Windows titleBarOverlay drag strip; height reserved via body padding. */}
      {typeof window !== "undefined" && window.ogb?.platform === "win32" ? (
        <div className="orbit-windows-caption" aria-hidden />
      ) : null}
      {/* the one tip layer for every title in the app */}
      <GlobalTooltip />
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      {themeToast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-hairline/50 bg-card px-3.5 py-1.5 text-[13px] text-ink shadow-xl"
        >
          {themeToast}
        </div>
      )}
      <div ref={drawerShellRef} className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label={menuQuestion ? t("ask.openBotList") : menuRoutine ? t("routine.openBotList") : t("chrome.openBotList")}
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        data-menu-needs-you={menuAsking || undefined}
        data-phone-menu
        data-arrival-glow={menuArrival.playing || undefined}
        onAnimationEnd={menuArrival.onAnimationEnd}
        className={`absolute z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden ${sidebarOnRight ? DRAWER_BUTTON_RIGHT : DRAWER_BUTTON_LEFT}${menuAsking ? " needs-you-glow" : ""}${menuArrival.playing ? " arrival-glow" : ""}`}
      >
        <Menu size={18} />
        {menuUnreadBadge != null && (
          <span
            data-menu-unread
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink"
          >
            {menuUnreadBadge}
          </span>
        )}
      </button>
      <div
        aria-hidden
        data-phone-drawer-scrim
        onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
        className={`absolute inset-0 z-30 bg-black/50 transition-opacity duration-(--motion-large) ease-entrance motion-reduce:transition-none md:hidden ${drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
      />
      <Sidebar
        open={drawerOpen}
        onOverlayChange={setSidebarOverlay}
        onClose={closeDrawer}
        onTerminalAttention={openTerminalAttention}
        folded={slotShown}
        onUnfold={() => slotPanels.forEach(closeSlot)}
        rigidView={Boolean(bot && terminalViews[bot.id] !== undefined)}
      />
      {noEngines ? (
        <LazyView fallback={<BootFallback />}>
          <NoEngines />
        </LazyView>
      ) : botsUnreadable ? (
        <main role="alert" className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app px-6 text-center text-ink-secondary">
          <div className="text-[14px] text-ink">{t("chrome.botsUnreadable")}</div>
          <div className="text-[12px]">{t("chrome.botsUnreadableHint")}</div>
        </main>
      ) : joinedId ? (
        <JoinedRoomView key={joinedId} roomId={joinedId} />
      ) : group && isTeamRoom(group) ? (
        <TeamRoomView key={group.id} group={group} />
      ) : group ? (
        LIVE_VERIFY_V0 ? (
          <div className={`relative flex min-h-0 min-w-0 flex-1${watchDock}`}>
            <GroupView key={group.id} group={group} />
            {watchPanel(nativeViewOverlayOpen)}
          </div>
        ) : (
          <GroupView key={group.id} group={group} />
        )
      ) : bot ? (
        <div ref={conversationRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip">
          <div ref={swipeStageRef} className={`flex min-h-0 flex-1${watchDock}`} inert={terminalOpen} aria-hidden={terminalOpen}>
            <ChatView
              bot={bot}
              hidden={terminalOpen || nativeViewOverlayOpen}
              focusComposerBlocked={paletteOpen || terminalOpen}
              onOpenTerminal={openMainTerminal}
              onOpenTerminalPane={openTerminalPane}
            />
            {watchPanel(terminalOpen || nativeViewOverlayOpen)}
          </div>
          {terminalViews[bot.id] !== undefined && (
            <div className="orbit-terminal-overlay absolute inset-0 z-20 flex" data-open={terminalOpen} inert={!terminalOpen} aria-hidden={!terminalOpen}>
              <LazyView fallback={<BootFallback label={t("terminal.connecting")} />}>
                {window.ogb?.terminal ? (
                  <TerminalWorkspace key={bot.id} bot={bot} visible={terminalOpen} focusBlocked={nativeViewOverlayOpen} paneFocus={botPaneFocus} onClose={closeTerminal} onPaneOrder={onPaneOrder} />
                ) : webTerminal ? (
                  <TerminalWorkspace key={bot.id} bot={bot} visible={terminalOpen} focusBlocked={nativeViewOverlayOpen} paneFocus={botPaneFocus} onClose={closeTerminal} onPaneOrder={onPaneOrder} webBridge={webTerminal} />
                ) : (
                  <RemoteTerminalView key={bot.id} bot={bot} visible={terminalOpen} paneFocus={botPaneFocus} onClose={closeTerminal} onPaneOrder={onPaneOrder} />
                )}
              </LazyView>
            </div>
          )}
        </div>
      ) : (
        <BootFallback
          label={state.connected && state.hydrated ? t("chrome.noBots") : t("chrome.connecting")}
          hint={
            !state.connected ? (
              <>
                {t("chrome.startServerHint")} <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
              </>
            ) : undefined
          }
        />
      )}
      <Presence open={Boolean(state.settingsOpen && bot)}>
        {(closing) => bot && (
          <LazyView overlay>
            <SettingsPanel key={bot.id} bot={bot} closing={closing} />
          </LazyView>
        )}
      </Presence>
      <Presence open={Boolean(state.inspectorOpen && bot)}>
        {(closing) => bot && (
          <LazyView overlay>
            <InspectorPanel bot={bot} closing={closing} />
          </LazyView>
        )}
      </Presence>
      <Presence open={state.appSettingsOpen}>
        {(closing) => (
          <LazyView overlay>
            <SettingsModal closing={closing} />
          </LazyView>
        )}
      </Presence>
      <Presence open={state.pluginsOpen}>
        {(closing) => (
          <LazyView overlay>
            <PluginsPanel closing={closing} />
          </LazyView>
        )}
      </Presence>
      <Presence open={createBotSheetOpen}>
        {(closing) => (
          <LazyView overlay>
            <CreateBotSheet required={createBotRequired} closing={closing} />
          </LazyView>
        )}
      </Presence>
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <LazyView overlay>
        <CommandPalette onOpenChange={setPaletteOpen} />
      </LazyView>
      </div>
    </div>
  );
}

const ONBOARDING_DONE_KEY = "omb-onboarding-done";

function onboardingDone(): boolean {
  try {
    return Boolean(localStorage.getItem(ONBOARDING_DONE_KEY) || localStorage.getItem("omb-email-gate"));
  } catch {
    return false;
  }
}

function setOnboardingDone() {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true");
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [onboardingOpen, setOnboardingOpen] = useState(() => !onboardingDone());
  useEffect(() => markColdOpen("mount"), []);
  useEffect(() => startIdleMotion(), []);
  return (
    <I18nProvider>
      <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell onboardingOpen={onboardingOpen} />
        {onboardingOpen && (
          <LazyView overlay fallback={<div className="orbit-inset-aware fixed inset-0 z-50 bg-app" />}>
            <Onboarding
              onDone={() => {
                setOnboardingDone();
                setOnboardingOpen(false);
              }}
            />
          </LazyView>
        )}
      </StoreProvider>
      </DesktopCapabilitiesProvider>
    </I18nProvider>
  );
}
