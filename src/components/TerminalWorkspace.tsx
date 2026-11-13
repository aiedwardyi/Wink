import { useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { ArrowLeft, ChevronDown, FolderOpen, SquareX, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Bot } from "@/state/store";
import { api, useStore, visibleMessages } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { readTerminalMatch, terminalTheme, TERMINAL_APPEARANCE_EVENT } from "@/lib/terminal-appearance";
import { createTerminalLineTracker } from "@/lib/terminal-input";
import { loadWebTerminalFonts, webTerminalFonts, type LiveOutput, type TerminalBridge } from "@/lib/web-terminal-bridge";
import { workerPaneOrder } from "@/lib/terminal-hotkeys";
import { latestPaneRun, paneProvider, parseWorkerLabel, rosterChip, workerRuns } from "@/lib/worker-runs";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { Presence } from "@/lib/use-presence";
import { ConfirmDialog } from "./ConfirmDialog";
import { WorkerChip, WorkerMark } from "./WorkerRows";
import "@xterm/xterm/css/xterm.css";
import { trackFeatureOnce } from "@/lib/usage-stats";

type SessionInfo = { cwd: string; shell: string };
type OutputEvent = LiveOutput;
type TerminalSnapshot = { id: string; cwd: string; shell: string; output: string; exitCode: number | null; seq: number; launchProject?: string | null; label?: string; cols?: number; rows?: number; alternate?: boolean; modes?: number[]; resetModes?: number[] };
type BotPane = { id: string; label: string | null; exited?: boolean; changedAt?: number };
const TERMINAL_FONT_MIN = 8;
const TERMINAL_FONT_MAX = 128;
const HEADER_CONTROL = "text-ink-secondary hover:bg-raised hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text";

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const norm = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

// Per bot, in memory: last picked pane, or null for Main.
export const lastViewedPanes = new Map<string, string | null>();
// Live output queues of mounted overlays (read by tests).
export const terminalLiveQueues: { id: string; data: string; seq: number }[][] = [];

export function pickInitialPane(panes: { id: string; exited?: boolean }[], lastViewedId?: string | null): string | null {
  if (lastViewedId !== undefined && panes.some((item) => item.id === lastViewedId)) return lastViewedId;
  return null;
}

export function folderBasename(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop();
  return base || cwd;
}

export function TerminalWorkspace({
  bot,
  onClose,
  focusBlocked,
  visible,
  paneFocus,
  onPaneOrder,
  webBridge,
}: {
  bot: Pick<Bot, "id" | "name" | "busy" | "cwd"> & Partial<Pick<Bot, "messages" | "activeLeafId" | "hasMore">>;
  onClose: () => void;
  focusBlocked: boolean;
  visible: boolean;
  paneFocus?: { sessionId: string | null } | null;
  onPaneOrder?: (botId: string, order: string[] | null) => void;
  /** A desktop browser's live bridge; the app uses its preload. */
  webBridge?: TerminalBridge;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const sidebarOnRight = useSidebarSide() === "right";
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const visibleRef = useRef(visible);
  const projectRef = useRef(bot.cwd ?? null);
  const botIdRef = useRef(bot.id);
  const blockedRef = useRef(focusBlocked || !visible);
  const openShellRef = useRef<((restart: boolean) => void) | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const dropPendingReplayRef = useRef<(() => void) | null>(null);
  const replacingRef = useRef(false);
  const forwardInputRef = useRef<(data: string) => void>(() => {});
  const composingRef = useRef(false);
  const lineInputsRef = useRef(new Map<string, ReturnType<typeof createTerminalLineTracker>>());
  const workers = useMemo(
    () => workerRuns(visibleMessages({ messages: bot.messages ?? [], activeLeafId: bot.activeLeafId, hasMore: bot.hasMore })),
    [bot.messages, bot.activeLeafId, bot.hasMore],
  );
  const workersRef = useRef(workers);
  useLayoutEffect(() => {
    blockedRef.current = focusBlocked || !visible;
    visibleRef.current = visible;
    projectRef.current = bot.cwd ?? null;
    botIdRef.current = bot.id;
    workersRef.current = workers;
  }, [focusBlocked, visible, bot.cwd, bot.id, workers]);
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [launchProject, setLaunchProject] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [needsFolder, setNeedsFolder] = useState(false);
  const [folderReason, setFolderReason] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeTarget, setCloseTarget] = useState<{ id: string; name: string } | null>(null);
  const [panes, setPanes] = useState<BotPane[]>([]);
  const [pane, setPane] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);
  const pickedRef = useRef(false);
  const selectPane = (id: string | null) => {
    pickedRef.current = true;
    lastViewedPanes.set(bot.id, id);
    setPane(id);
  };
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const projectMismatch = Boolean(session && !samePath(bot.cwd ?? null, launchProject));
  const showProjectBanner = projectMismatch && !bannerDismissed && !webBridge;
  const folderLabel = bot.cwd ? folderBasename(bot.cwd) : t("terminal.privateWorkspace");
  const folderTooltip = bot.cwd ?? t("terminal.privateWorkspace");

  useEffect(() => {
    setBannerDismissed(false);
  }, [bot.cwd]);

  // Bot-spawned panes: seeded once, then pushed by the host on open.
  useEffect(() => {
    const bridge = webBridge ?? window.ogb?.terminal;
    setPanes([]);
    setPane(null);
    setSeeded(false);
    if (!bridge) return;
    let alive = true;
    const closed = new Set<string>();
    void Promise.resolve().then(() => bridge.readBot?.(bot.id)).then((snapshot) => {
      if (!alive || !snapshot?.panes) return;
      const seeded = snapshot.panes.filter((item) => !item.main && !closed.has(item.sessionId)).map((item) => ({ id: item.sessionId, label: item.label, exited: item.exited, changedAt: item.changedAt }));
      setPanes((list) => [...seeded, ...list.filter((item) => !seeded.some((seed) => seed.id === item.id))]);
    }).catch(() => {}).finally(() => { if (alive) setSeeded(true); });
    const offOpened = bridge.onOpened?.((event) => {
      if (event.botId !== bot.id) return;
      setPanes((list) => list.some((item) => item.id === event.id) ? list : [...list, { id: event.id, label: event.label }]);
    });
    const offExit = bridge.onExit((event) => {
      setPanes((list) => list.map((item) => item.id === event.id && !item.exited ? { ...item, exited: true } : item));
    });
    const offClosed = bridge.onClosed?.((event) => {
      if (event.botId !== bot.id) return;
      closed.add(event.id);
      if (lastViewedPanes.get(bot.id) === event.id) lastViewedPanes.set(bot.id, null);
      setPanes((list) => list.filter((item) => item.id !== event.id));
      setPane((current) => current === event.id ? null : current);
    });
    return () => {
      alive = false;
      offOpened?.();
      offExit();
      offClosed?.();
    };
  }, [bot.id]);

  // xterm + bridge listeners for this bot. Shell open waits until visible.
  useEffect(() => {
    const host = hostRef.current;
    const bridge = webBridge ?? window.ogb?.terminal;
    if (!host || !bridge) return;
    let alive = true;
    let id: string | null = null;
    let lastSeq = 0;
    let frame = 0;
    let appearanceRequest = 0;
    let opening = false;
    let replayComplete = false;
    let replaying = false;
    let seen: IntersectionObserver | null = null;
    const liveQueue: OutputEvent[] = [];
    terminalLiveQueues.push(liveQueue);
    const exits = new Map<string, number>();
    setSession(null);
    setLaunchProject(null);
    setExitCode(null);
    setError("");
    setNeedsFolder(false);
    setFolderReason(null);
    setReplacing(false);
    replacingRef.current = false;
    sessionIdRef.current = null;
    const terminal = new Terminal({
      cursorBlink: false,
      fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "Cascadia Code NF", "Cascadia Mono", Consolas, "Malgun Gothic", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      allowProposedApi: false,
      disableStdin: true,
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    // Ctrl+click follows links: xterm reports mousedown bytes before the linkifier
    // activates, so plain-click links would also click through to mouse-mode TUIs.
    const openLink = (event: MouseEvent, url: string) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!/^https?:\/\//i.test(url)) return;
      void window.ogb?.openExternal?.(url);
    };
    const showLink = (url: string | null) => {
      if (url) host.title = url;
      else host.removeAttribute("title");
    };
    const links = new WebLinksAddon(openLink, {
      hover: (_event, text) => showLink(text),
      leave: () => showLink(null),
    });
    terminal.loadAddon(links);
    terminal.options.linkHandler = {
      activate: openLink,
      hover: (_event, text) => showLink(text),
      leave: () => showLink(null),
    };
    terminal.open(host);
    const report = (cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); };
    const defaultFont = webBridge ? webTerminalFonts(terminal.options.fontFamily ?? "") : terminal.options.fontFamily;
    const theme = async () => {
      const request = ++appearanceRequest;
      const imported = readTerminalMatch() ? await bridge.appearance?.().catch(() => null) : null;
      // xterm measures cells when the font option changes, so a web font must be loaded by then.
      if (webBridge) await loadWebTerminalFonts();
      if (!alive || request !== appearanceRequest) return;
      const css = getComputedStyle(host);
      const color = (name: string) => css.getPropertyValue(`--color-${name}`).trim();
      terminal.options.fontFamily = imported?.fontFamily ? `${JSON.stringify(imported.fontFamily)}, monospace` : defaultFont;
      terminal.options.fontSize = imported?.fontSize ?? 13;
      terminal.options.theme = { ...terminalTheme(color), ...imported?.theme };
      // Imported schemes and truecolor prompts bypass the readable palette.
      terminal.options.minimumContrastRatio = 4.5;
      if (host.parentElement) host.parentElement.style.backgroundColor = imported?.theme.background ?? "";
      if (replaying) return;
      fit.fit();
      if (id) {
        const sessionId = id;
        void Promise.resolve().then(() => bridge.resize(sessionId, terminal.cols, terminal.rows)).catch(report);
      }
    };
    void theme();
    fit.fit();
    const receive = (event: OutputEvent) => {
      if (event.id !== id || event.seq <= lastSeq) return;
      if (!replayComplete) {
        liveQueue.push(event);
        return;
      }
      lastSeq = event.seq;
      if (event.done) terminal.write(event.data, event.done);
      else terminal.write(event.data);
    };
    const offData = bridge.onData((event) => {
      if (replayComplete) {
        receive(event);
        return;
      }
      // Queue only the attaching session; drop everything while no attach is in flight.
      if (!opening && (id === null || event.id !== id)) return;
      liveQueue.push(event);
    });
    const offExit = bridge.onExit((event) => {
      if (!replayComplete || event.id === id) exits.set(event.id, event.exitCode);
      if (event.id === id) {
        terminal.options.disableStdin = true;
        setExitCode(event.exitCode);
      }
    });
    const offError = bridge.onError?.((event) => {
      if (event.id === id) {
        terminal.options.disableStdin = true;
        report(event.message);
      }
    });
    // Forward keystrokes and emulator replies only after historical replay finishes.
    // onBinary carries non-UTF8 mouse reports (wheel in X10/RXVT mode); without it the wheel is dropped.
    const forwardInput = (data: string, track = true) => {
      if (!id || !replayComplete || terminal.options.disableStdin || exits.has(id)) return;
      if (track) trackFeatureOnce("terminal.type");
      const sessionId = id;
      let submitted = false;
      if (track && panesRef.current.some((pane) => pane.id === sessionId)) {
        let input = lineInputsRef.current.get(sessionId);
        if (!input) {
          input = createTerminalLineTracker();
          lineInputsRef.current.set(sessionId, input);
        }
        submitted = input(data);
      }
      const afterMessageId = submitted ? latestPaneRun(workersRef.current, sessionId)?.messageIds.at(-1) : undefined;
      const typedAt = Date.now();
      const send = () => Promise.resolve(bridge.write(sessionId, data)).then(() => {
        if (submitted) void Promise.resolve(api(`/api/bots/${encodeURIComponent(bot.id)}/terminal/resume`, {
          method: "POST", body: JSON.stringify({ sessionId, afterMessageId, submittedAgo: Date.now() - typedAt }),
        })).catch(() => {});
      }).catch(report);
      // Submit keys skip the microtask queue so they cannot stall behind DA/mouse replies.
      if (/[\r\n]/.test(data)) void send();
      else void Promise.resolve().then(send);
    };
    forwardInputRef.current = forwardInput;
    const input = terminal.onData((data) => forwardInput(data));
    const inputBinary = terminal.onBinary((data) => forwardInput(data, false));
    // Windows Terminal copy/paste. xterm maps Ctrl+C/V to raw control bytes
    // (^C/^V) and leaves Shift+Insert dead, so claim them here. False claims.
    const copySelection = (text: string) => {
      const finish = () => {
        if (alive) terminal.clearSelection();
      };
      void Promise.resolve()
        .then(() => navigator.clipboard.writeText(text))
        .catch(() => window.ogb?.clipboard?.writeText(text))
        .then(finish, finish);
    };
    const readClipboardText = async (): Promise<string> => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        // Renderer clipboard is unreadable; try the native bridge next.
      }
      try {
        return (await window.ogb?.clipboard?.readText()) ?? "";
      } catch {
        return "";
      }
    };
    const pasteClipboard = () => {
      void readClipboardText().then((text) => {
        if (!alive || !text) return;
        if (terminal.options.disableStdin) return;
        terminal.paste(text);
      });
    };
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (event.metaKey || event.altKey) return true;
      if (terminal.options.disableStdin || (id !== null && exits.has(id))) return true;
      const key = (event.key ?? "").toLowerCase();
      const isCopyKey = key === "c" || event.keyCode === 67;
      const isPasteKey = key === "v" || event.keyCode === 86;
      const isInsertKey = key === "insert" || event.keyCode === 45;
      if (event.ctrlKey && isCopyKey) {
        // Bare Ctrl+C with no selection keeps today's ^C (interrupt/close).
        if (!event.shiftKey && !terminal.hasSelection()) return true;
        const selected = terminal.getSelection();
        if (selected) copySelection(selected);
        else terminal.clearSelection();
        return false;
      }
      if (event.ctrlKey && isPasteKey) {
        // Native paste owns this: false skips xterm's ^V mapping without
        // canceling the keydown, so Chromium fires one paste on the textarea.
        return false;
      }
      if (event.shiftKey && !event.ctrlKey && isInsertKey) {
        event.preventDefault();
        pasteClipboard();
        return false;
      }
      return true;
    });
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive || replaying || !host.clientWidth || !host.clientHeight) return;
        fit.fit();
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        if (id) {
          const sessionId = id;
          void Promise.resolve().then(() => bridge.resize(sessionId, terminal.cols, terminal.rows)).catch(report);
        }
      });
    };
    resizeRef.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const updateAppearance = () => { void theme(); };
    window.addEventListener(TERMINAL_APPEARANCE_EVENT, updateAppearance);
    const appearance = new MutationObserver(() => { void theme(); resize(); });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "data-shape"] });

    let attachedLaunchProject: string | null = null;
    const finishAttach = (snapshot: TerminalSnapshot, launchedProject: string | null, modesRestored = false) => {
      if (!alive) return;
      if (!modesRestored) {
        const restoreModes = [
          ...(snapshot.resetModes ?? []).map((mode) => `\x1b[?${mode}l`),
          ...(snapshot.modes ?? [])
            .filter((mode) => mode !== 47 && mode !== 1047 && mode !== 1049)
            .map((mode) => `\x1b[?${mode}h`),
        ]
          .join("");
        if (restoreModes) {
          terminal.write(restoreModes, () => finishAttach(snapshot, launchedProject, true));
          return;
        }
      }
      // Use lastSeq (not snapshot.seq): same-id fallback never advances lastSeq to
      // resumed.seq, so IPC-gap events in (lastSeq, snapshot.seq] stay drainable.
      const queued = [...liveQueue]
        .filter((event) => event.id === snapshot.id && event.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq);
      liveQueue.length = 0;
      replayComplete = true;
      replaying = false;
      for (const event of queued) receive(event);
      const code = exits.get(snapshot.id) ?? snapshot.exitCode;
      if (code !== null) exits.set(snapshot.id, code);
      setExitCode(code);
      terminal.options.disableStdin = code !== null;
      setSession({ cwd: snapshot.cwd, shell: snapshot.shell });
      const project = "launchProject" in snapshot ? snapshot.launchProject ?? null : launchedProject;
      attachedLaunchProject = project;
      setLaunchProject(project);
      setNeedsFolder(false);
      setFolderReason(null);
      setBannerDismissed(false);
      setReplacing(false);
      replacingRef.current = false;
      resize();
      // Diff-rendering TUIs cannot be rebuilt from replayed history alone; a size
      // bounce forces the app to repaint from live state (same trio a manual resize runs).
      if (snapshot.alternate === true && code === null && terminal.rows > 1) {
        const repaintId = snapshot.id;
        const repaintCols = terminal.cols;
        const repaintRows = terminal.rows;
        void Promise.resolve()
          .then(() => bridge.resize(repaintId, repaintCols, repaintRows - 1))
          .then(() => bridge.resize(repaintId, repaintCols, repaintRows))
          .catch(report);
      }
      if (!blockedRef.current) terminal.focus();
    };
    // A replay that never reached the screen is stale: reset the attach so the
    // next show opens fresh instead of queueing output while hidden.
    const dropPendingReplay = () => {
      seen?.disconnect();
      seen = null;
      liveQueue.length = 0;
      replaying = false;
      id = null;
      sessionIdRef.current = null;
    };
    dropPendingReplayRef.current = () => { if (seen) dropPendingReplay(); };
    // ConPTY draws at absolute rows and never repaints on resize, so history only lines up at the PTY's size.
    const replay = (snapshot: TerminalSnapshot, launchedProject: string | null) => {
      replaying = true;
      if (typeof IntersectionObserver === "undefined") {
        if (snapshot.cols && snapshot.rows) terminal.resize(snapshot.cols, snapshot.rows);
        terminal.write(snapshot.output, () => finishAttach(snapshot, launchedProject));
        return;
      }
      if (!visibleRef.current) {
        // Open settled while hidden: never arm a replay the screen cannot fire.
        dropPendingReplay();
        return;
      }
      // xterm pauses off-screen, and a resize there strands its viewport short of the bottom (xterm 6 never resyncs on render size).
      seen?.disconnect();
      const onScreen = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (seen !== onScreen) return;
        onScreen.disconnect();
        seen = null;
        if (!alive) return;
        if (snapshot.cols && snapshot.rows) terminal.resize(snapshot.cols, snapshot.rows);
        terminal.write(snapshot.output, () => finishAttach(snapshot, launchedProject));
      });
      seen = onScreen;
      onScreen.observe(host);
    };

    const recoverPreservedSession = () => {
      if (!id) return;
      const isExited = exits.has(id);
      const queued = [...liveQueue]
        .filter((event) => event.id === id && event.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq);
      liveQueue.length = 0;
      replayComplete = true;
      for (const event of queued) receive(event);
      terminal.options.disableStdin = isExited;
      if (isExited) {
        setExitCode(exits.get(id)!);
      } else if (!blockedRef.current) {
        terminal.focus();
      }
    };

    const openShell = (restart: boolean) => {
      if (!alive || opening || !visibleRef.current) return;
      if (id && !restart) return;
      if (restart && replacingRef.current) return;
      const expectedBotId = botIdRef.current;
      const expectedProject = projectRef.current;
      opening = true;
      if (restart) {
        replacingRef.current = true;
        setReplacing(true);
      }
      setError("");
      setNeedsFolder(false);
      setFolderReason(null);
      liveQueue.length = 0;
      replayComplete = false;
      terminal.options.disableStdin = true;
      const openInput: Parameters<typeof bridge.open>[0] = { botId: expectedBotId, cols: terminal.cols, rows: terminal.rows, restart, projectCwd: expectedProject };
      if (pane) openInput.sessionId = pane;
      void Promise.resolve().then(() => bridge.open(openInput)).then(async (result) => {
        opening = false;
        if (!alive) return;
        if (botIdRef.current !== expectedBotId) {
          setReplacing(false);
          replacingRef.current = false;
          return;
        }
        if ("needsFolder" in result && result.needsFolder) {
          if (restart) {
            // Host keeps the prior session when the new target is unavailable.
            // Defer needsFolder until fallback open settles — avoid flashing the banner mid-resume.
            try {
              // Resume id unknown until open settles: queue everything like an open in flight.
              opening = true;
              const resumed = await bridge.open({ botId: expectedBotId, cols: terminal.cols, rows: terminal.rows, restart: false });
              opening = false;
              if (!alive) return;
              if (botIdRef.current !== expectedBotId) {
                setReplacing(false);
                replacingRef.current = false;
                return;
              }
              if (!("needsFolder" in resumed)) {
                // Same session already painted in xterm — skip re-dump to avoid duplicate scrollback.
                if (resumed.id !== id) {
                  id = resumed.id;
                  sessionIdRef.current = resumed.id;
                  lastSeq = resumed.seq;
                  replayComplete = false;
                  replay(resumed, expectedProject);
                } else {
                  // Same session already painted — skip re-dump, but still finishAttach for live drain + resize/focus.
                  // Keep lastSeq at the pre-restart watermark so finishAttach preserves IPC-gap events.
                  finishAttach(resumed, attachedLaunchProject);
                }
                return;
              }
              setNeedsFolder(true);
              setFolderReason(resumed.reason ?? result.reason ?? "choose-folder");
              recoverPreservedSession();
            } catch (cause) {
              opening = false;
              report(cause);
              setNeedsFolder(true);
              setFolderReason(result.reason ?? "choose-folder");
              recoverPreservedSession();
            }
            setReplacing(false);
            replacingRef.current = false;
          } else {
            setNeedsFolder(true);
            setFolderReason(result.reason ?? "choose-folder");
            id = null;
            sessionIdRef.current = null;
            setSession(null);
            setLaunchProject(null);
            setReplacing(false);
            replacingRef.current = false;
          }
          return;
        }
        // SAFETY: this branch follows the needsFolder discriminant from the terminal bridge.
        const snapshot = result as TerminalSnapshot;
        id = snapshot.id;
        sessionIdRef.current = snapshot.id;
        lastSeq = snapshot.seq;
        replayComplete = false;
        replay(snapshot, expectedProject);
      }).catch((cause) => {
        opening = false;
        setReplacing(false);
        replacingRef.current = false;
        if (!alive || botIdRef.current !== expectedBotId) return;
        report(cause);
        if (restart) recoverPreservedSession();
      });
    };
    openShellRef.current = openShell;
    if (visibleRef.current) openShell(generation > 0);

    return () => {
      alive = false;
      if (bridge.cancelOpen) void bridge.cancelOpen(bot.id).catch(() => {});
      openShellRef.current = null;
      dropPendingReplayRef.current = null;
      cancelAnimationFrame(frame);
      seen?.disconnect();
      seen = null;
      const queueIndex = terminalLiveQueues.indexOf(liveQueue);
      if (queueIndex >= 0) terminalLiveQueues.splice(queueIndex, 1);
      observer.disconnect();
      appearance.disconnect();
      window.removeEventListener(TERMINAL_APPEARANCE_EVENT, updateAppearance);
      offData();
      offExit();
      offError?.();
      input.dispose();
      inputBinary.dispose();
      links.dispose();
      host.removeAttribute("title");
      forwardInputRef.current = () => {};
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      resizeRef.current = null;
      sessionIdRef.current = null;
    };
  }, [bot.id, generation, pane]);

  // Hidden remount stays quiet; becoming visible opens or resumes once.
  useEffect(() => {
    if (visible) {
      openShellRef.current?.(false);
      // The overlay keeps layout size while hidden, so no ResizeObserver fires on
      // return; run the resize trio (fit + refresh + PTY sync) explicitly.
      resizeRef.current?.();
    } else {
      dropPendingReplayRef.current?.();
    }
  }, [visible]);

  useEffect(() => {
    if (visible && !focusBlocked) terminalRef.current?.focus();
  }, [visible, focusBlocked]);

  // Each open lands on the last picked pane or Main. Waits for the seed.
  useEffect(() => {
    if (!visible) pickedRef.current = false;
    else if (seeded && !pickedRef.current) {
      pickedRef.current = true;
      const initial = pickInitialPane(panes, lastViewedPanes.get(bot.id));
      // A remembered pane may have closed while this bot was unmounted.
      if (lastViewedPanes.has(bot.id)) lastViewedPanes.set(bot.id, initial);
      setPane(initial);
    }
  }, [visible, seeded, panes, bot.id]);

  // Waits for the pane: a cold open seeds panes after mount.
  const focusedRef = useRef<typeof paneFocus>(null);
  useEffect(() => {
    if (!paneFocus || focusedRef.current === paneFocus) return;
    if (paneFocus.sessionId !== null && !panes.some((item) => item.id === paneFocus.sessionId)) return;
    focusedRef.current = paneFocus;
    selectPane(paneFocus.sessionId);
  }, [paneFocus, panes]);

  const onTerminalWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    event.preventDefault();
    event.stopPropagation();
    const current = terminal.options.fontSize ?? 13;
    const next = Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, current + (event.deltaY < 0 ? 1 : -1)));
    if (next === current) return;
    terminal.options.fontSize = next;
    resizeRef.current?.();
  };

  const chooseAndPersist = async () => {
    if (choosing) return;
    setChoosing(true);
    setError("");
    try {
      const picked = await window.ogb?.pickFolder?.(bot.cwd ?? undefined);
      if (!picked) return;
      const result: { bot?: Bot } = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ cwd: picked }),
      });
      if (result.bot) dispatch({ type: "botPatched", bot: result.bot });
      setNeedsFolder(false);
      setFolderReason(null);
      // Persist only - never inject cd or kill a live session from folder pick.
      if (pane === null && !sessionIdRef.current) setGeneration((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(false);
    }
  };

  const requestRestartHere = () => {
    if (pane !== null || replacing || replacingRef.current) return;
    if (exitCode === null && sessionIdRef.current) setConfirmRestart(true);
    else {
      setBannerDismissed(false);
      // Dead/missing session: in-place restart (restart:true). openShell(false) would early-return while id is still set.
      if (openShellRef.current) openShellRef.current(true);
      else setGeneration((value) => value + 1);
    }
  };

  const closePane = (id: string) => {
    setPanes((list) => list.filter((item) => item.id !== id));
    if (pane === id) setPane(null);
    void Promise.resolve().then(() => (webBridge ?? window.ogb?.terminal)?.close?.(id)).catch(() => {});
  };
  const requestClosePane = (id: string) => {
    const target = panes.find((item) => item.id === id);
    if (!target) return;
    if (target.exited) closePane(id);
    else {
      setCloseTarget({ id, name: parseWorkerLabel(target.label).nick ?? id.slice(0, 8) });
      setConfirmClose(true);
    }
  };
  const roster = panes.map((item) => ({ sessionId: item.id, label: item.label, exited: item.exited, changedAt: item.changedAt }));
  const chip = rosterChip(workers, roster);
  const paneOrder = workerPaneOrder(roster, workers);
  useLayoutEffect(() => {
    if (!visible) return;
    onPaneOrder?.(bot.id, paneOrder);
    return () => onPaneOrder?.(bot.id, null);
  }, [bot.id, visible, onPaneOrder, paneOrder]);
  const watched = pane === null ? null : parseWorkerLabel(panes.find((item) => item.id === pane)?.label).nick ?? pane.slice(0, 8);
  const hotkeyOf = (sessionId: string | null) => {
    if (sessionId === null) return undefined;
    const index = paneOrder.indexOf(sessionId);
    return index >= 0 && index < 9 ? index + 1 : undefined;
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-inset text-ink" aria-label={t("terminal.title")}>
      <header className={`@container/chathead flex h-[72px] shrink-0 items-center gap-3 border-b border-hairline bg-panel px-5 max-md:h-[60px] ${sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT}`}>
        <button type="button" onClick={onClose} className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${HEADER_CONTROL}`}>
          <ArrowLeft size={15} /> {t("terminal.chat")} <kbd className="text-[10px] text-ink-secondary">{window.ogb?.platform === "darwin" ? "⌘" : "Ctrl+"}`</kbd>
        </button>
        <span className="h-5 border-l border-hairline" aria-hidden />
        <TerminalSquare size={16} className="shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-medium">{t("terminal.title")} <span className="text-ink-secondary">/ {pane !== null && <WorkerMark compact provider={paneProvider(workers, pane, panes.find((item) => item.id === pane)?.label)} />}{watched ?? bot.name}</span></h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            {webBridge ? (
              <span title={folderTooltip} className="inline-flex min-w-0 max-w-full items-center gap-1 px-1.5 py-0.5 text-[11px] text-ink-secondary">
                <FolderOpen size={12} className="shrink-0" />
                <span className="min-w-0 truncate font-mono">{folderLabel}</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void chooseAndPersist()}
                disabled={choosing || replacing}
                title={folderTooltip}
                aria-label={t("terminal.chooseFolder")}
                className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11px] disabled:opacity-60 ${HEADER_CONTROL}`}
              >
                <FolderOpen size={12} className="shrink-0" />
                <span className="min-w-0 truncate font-mono">{folderLabel}</span>
                <ChevronDown size={11} className="shrink-0 opacity-70" />
              </button>
            )}
            {projectMismatch && bannerDismissed ? (
              <span className="shrink-0 text-[11px] text-ink-secondary" title={launchProject ?? undefined}>· {t("terminal.differentProject")}</span>
            ) : null}
          </div>
        </div>
        {bot.busy && <span className="shrink-0 text-[11px] text-accent-text" role="status">{t("terminal.agentWorking")}</span>}
        {pane !== null && !webBridge && (
          <button type="button" onClick={() => requestClosePane(pane)} aria-label={t("terminal.closePane")} title={t("terminal.closePane")} className={`flex shrink-0 items-center justify-center rounded-md p-1.5 ${HEADER_CONTROL}`}>
            <SquareX size={16} />
          </button>
        )}
        <WorkerChip name={bot.name} {...chip} onOpenTerminalPane={selectPane} onOpenTerminal={() => selectPane(null)} hotkeyOf={hotkeyOf} className={`rounded-md [&_.text-ink-secondary]:text-inherit ${HEADER_CONTROL}`} />
      </header>
      {showProjectBanner && (
        <div role="status" className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-inset px-5 py-1.5 text-[12px] text-ink">
          <span className="min-w-0 flex-1" title={launchProject ?? undefined}>
            {t("terminal.projectChanged")}
            {launchProject ? <span className="ml-2 font-mono text-[11px] text-ink-secondary">{launchProject}</span> : null}
          </span>
          <button type="button" onClick={requestRestartHere} disabled={replacing || pane !== null} className="shrink-0 text-accent-text underline disabled:opacity-60">
            {t("terminal.restartHere")}
          </button>
          <button type="button" onClick={() => setBannerDismissed(true)} className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("terminal.dismissBanner")}>
            <X size={14} />
          </button>
        </div>
      )}
      {needsFolder && (
        <div
          role={folderReason === "explicit-unavailable" ? "alert" : "status"}
          className={`flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3 text-[13px] ${
            folderReason === "explicit-unavailable" ? "border-danger/30 bg-danger/10 text-danger" : "border-hairline bg-panel text-ink"
          }`}
        >
          <span>{folderReason === "explicit-unavailable" ? t("terminal.folderMissing") : t("terminal.chooseFolderHelp")}</span>
          <button type="button" onClick={() => void chooseAndPersist()} disabled={choosing} className="inline-flex shrink-0 items-center gap-1.5 text-accent-text underline disabled:opacity-60">
            <FolderOpen size={14} /> {t("terminal.chooseFolder")}
          </button>
        </div>
      )}
      {error && !needsFolder && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-danger/30 bg-danger/10 px-5 py-3 text-[13px] text-danger">
          <span>{error}</span>
          <button type="button" onClick={() => setGeneration((value) => value + 1)} disabled={replacing} className="shrink-0 underline disabled:opacity-60">{t("terminal.retry")}</button>
        </div>
      )}
      <div
        data-orbit-terminal
        className="min-h-0 flex-1 p-4"
        onKeyDownCapture={(event) => {
          if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.nativeEvent.isComposing ||
            composingRef.current ||
            event.keyCode === 229 ||
            event.nativeEvent.keyCode === 229 ||
            event.repeat
          ) return;
          event.preventDefault();
          event.stopPropagation();
          forwardInputRef.current("\r");
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onWheelCapture={onTerminalWheel}
      >
        <div ref={hostRef} className="h-full w-full" />
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-hairline bg-panel px-5 py-2 text-[11px] text-ink-secondary">
        <span>
          {exitCode === null
            ? session?.shell.split(/[\\/]/).at(-1) ?? (needsFolder ? t("terminal.chooseFolder") : error ? t("terminal.unavailable") : t("terminal.connecting"))
            : t("terminal.exited", { code: exitCode })}
        </span>
        {exitCode !== null ? (
          !webBridge && <button type="button" onClick={requestRestartHere} disabled={replacing || pane !== null} className="text-accent-text underline disabled:opacity-60">{t("terminal.restart")}</button>
        ) : (
          <span>{t("terminal.lifetime")}</span>
        )}
      </footer>
      <Presence open={confirmClose}>
        {(closing) => closeTarget && (
          <ConfirmDialog
            closing={closing}
            title={t("terminal.closePaneConfirmTitle")}
            body={t("terminal.closePaneConfirmBody", { name: closeTarget.name })}
            confirmLabel={t("terminal.closePane")}
            onCancel={() => setConfirmClose(false)}
            onConfirm={() => {
              closePane(closeTarget.id);
              setConfirmClose(false);
            }}
          />
        )}
      </Presence>
      <Presence open={confirmRestart}>
        {(closing) => (
          <ConfirmDialog
            closing={closing}
            title={t("terminal.restartConfirmTitle", { folder: folderLabel })}
            body={t("terminal.restartConfirmBody")}
            confirmLabel={t("terminal.restartConfirmAction")}
            danger
            onCancel={() => setConfirmRestart(false)}
            onConfirm={() => {
              setConfirmRestart(false);
              setBannerDismissed(false);
              // In-place restart keeps painted scrollback; fallback can skip re-dump when session id matches.
              if (openShellRef.current) openShellRef.current(true);
              else setGeneration((value) => value + 1);
            }}
          />
        )}
      </Presence>
    </main>
  );
}

