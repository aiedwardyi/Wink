import { ChevronRight, FolderOpen, Settings, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { stateForBot } from "@/lib/mascot";
import { WorkingFolderField } from "./WorkingFolderField";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { memoryNotesEnabled } from "@/lib/feature-flags";
import { showBotVoiceAndStartupSettings, showDisabledShareTerminal } from "@/lib/friends-chrome";
import {
  dropMemory,
  editMemory,
  flushMemory,
  keepMemory,
  memoryDraft,
  memorySaves,
  openMemory,
  watchMemory,
  type MemoryLatest,
} from "@/lib/memory-drafts";
import { requestNotificationPermission } from "@/lib/notify";
import { shortPath } from "@/lib/short-path";
import { MOTION_MODERATE_MS } from "@/lib/motion";
import { hapticTick, reducedMotion } from "@/lib/phone-swipe";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { useSettingsSwipe } from "@/lib/use-settings-swipe";
import { useDetailsTabs } from "@/lib/use-details-tabs";
import { BotAvatar } from "./Avatar";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { currentTask, MemoryEditButton, MemoryEmpty, MemoryFile, MemoryGroup, SaveState, type MemorySaveStatus, type MemoryTopic } from "./MemoryGroups";
import { DETAILS_BOX, DETAILS_INPUT, DETAILS_ROW, DetailsSwitch, FitTextarea, SwitchRow } from "./BotDetailsRows";
import { KeepGoingMark, keepGoingMarkState } from "./KeepGoingMark";
import { SegmentedRow } from "./Segmented";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { MemoryCleanRow } from "./MemoryCleanRow";
import { MemoryCleanIcon } from "./MemoryCleanMotion";
import { useMemoryClean } from "@/lib/memory-clean";
import { memoryTargetLine } from "@/lib/memory-recent";
import { botAsks } from "@/lib/asks";
import { useCoverChat } from "@/lib/cover-chat";
import { lazyView } from "@/lib/stale-build";
import { watchMemoryArrival } from "@/lib/memory-clean-events";
import { VoiceSettings } from "./VoiceSettings";
import { LazyView } from "./LazyView";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { Fold } from "./Fold";
import { SaveStatus } from "./SaveStatus";
import { STACK_BELOW, useStage } from "./MemoryMapStage";
// the map's CSS comes with Bot details, so a Memory tab open never waits on a stylesheet
import "./MemoryMap.css";

// One Bot Details is up at a time. A bot switch mounts the next panel (keyed by
// bot) while the last is still up, and must not replay the slide-in.
let panelsUp = 0;

function Field({
  label,
  hint,
  status,
  children,
}: {
  label: string;
  hint?: string;
  status?: ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className={cn(DETAILS_ROW, "block")} onClick={(event) => {
      if (event.target === event.currentTarget) event.preventDefault();
    }}>
      <div className={cn("mb-1.5 text-[14px] font-medium text-ink", status && "sticky top-0 z-10 bg-card")}>
        {label}
        {status}
        {hint && <div className="mt-0.5 break-keep text-[12px] font-normal leading-relaxed text-ink-secondary">{hint}</div>}
      </div>
      {children}
    </label>
  );
}

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
/** Keep a complete catalog phrase; wrap one `{name}` slot in JSX. */
function phraseWithNode(phrase: string, name: string, node: ReactNode): ReactNode {
  const token = `{${name}}`;
  const at = phrase.indexOf(token);
  if (at < 0) return phrase;
  return (
    <>
      {phrase.slice(0, at)}
      {node}
      {phrase.slice(at + token.length)}
    </>
  );
}

const KEEP_GOING_PAUSED = {
  "no-progress": "bot.keepGoingNoProgress",
  "bot-paused": "bot.keepGoingBotPaused",
  "other-pc": "bot.keepGoingOtherPc",
  "task-changed": "bot.keepGoingTaskChanged",
  "usage-unknown": "bot.keepGoingUsageUnknown",
  "usage-stale": "bot.keepGoingUsageStale",
} as const;

function KeepGoingCard({ bot }: { bot: Bot }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const rowRef = useRef<HTMLDivElement>(null);
  const request = state.settingsKeepGoingRequest ?? 0;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = Boolean(bot.keepGoing);
  const paused = bot.keepGoing?.paused;

  const toggle = async () => {
    setSaving(true);
    setError(null);
    try {
      const result: { bot?: Bot } = await api(`/api/bots/${bot.id}/keep-going`, {
        method: "POST",
        body: JSON.stringify({ on: !on }),
      });
      if (result.bot) dispatch({ type: "botPatched", bot: result.bot });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (request > 0) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [request]);

  return (
    <div ref={rowRef} data-settings-keep-going className={DETAILS_BOX}>
      <div className={DETAILS_ROW}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <KeepGoingMark state={keepGoingMarkState(bot) ?? "off"} size={14} />
            <div className="truncate text-[14px] font-medium text-ink">{t("bot.keepGoing")}</div>
          </div>
          <DetailsSwitch on={on} label={t("bot.keepGoing")} disabled={saving} className="disabled:cursor-wait" onToggle={() => void toggle()} />
        </div>
        <div className="mt-1 whitespace-pre-line break-keep text-[12px] leading-relaxed text-ink-secondary">
          {paused ? t("bot.keepGoingPaused", { reason: t(KEEP_GOING_PAUSED[paused]) }) : t("bot.keepGoingHelp")}
        </div>
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      </div>
    </div>
  );
}

function WorkingFolder({ bot }: { bot: Bot }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const liveCwd = pinned === undefined ? bot.cwd : pinned;
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== (bot.cwd ?? undefined);

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const result: { bot?: Bot } = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ cwd }),
      });
      if (result.bot) dispatch({ type: "botPatched", bot: result.bot });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd ?? undefined);
    if (chosen) void save(chosen);
  };

  return (
    <div className={DETAILS_BOX}>
      <div className={DETAILS_ROW}>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[14px] font-medium text-ink">{t("bot.workingFolder")}</div>
          {canPick && (
            <div className="flex shrink-0 items-center gap-2">
              <button onClick={() => void pick()} disabled={saving} className={cn(ROW_BUTTON, "gap-1.5 text-ink")}>
                <FolderOpen size={13} aria-hidden="true" /> {t("bot.workingFolderChoose")}
              </button>
              {bot.cwd && (
                <button onClick={() => void save(null)} disabled={saving} className={ROW_BUTTON}>
                  {t("bot.workingFolderClear")}
                </button>
              )}
            </div>
          )}
        </div>
        {canPick ? (
          <div className="mt-1 truncate text-[13px] text-ink" title={bot.cwd ?? undefined}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">{t("bot.workingFolderEmpty")}</span>}
          </div>
        ) : (
          <WorkingFolderField value={draft ?? bot.cwd ?? ""} onChange={setDraft} onSave={() => void save((draft ?? bot.cwd ?? "").trim() || null)} disabled={saving || draft === null} />
        )}
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
        {pinnedElsewhere && (
          <div className="mt-1 break-words text-[12px] leading-relaxed text-ink-secondary">
            {pinned
              ? phraseWithNode(t("bot.workingFolderPinned"), "folder", <span className="text-ink">{shortPath(pinned, home)}</span>)
              : t("bot.workingFolderPinnedHome")}
          </div>
        )}
        {bot.rememberedProjectCwd && bot.rememberedProjectCwd !== liveCwd && (
          <div className="mt-1 break-words text-[12px] leading-relaxed text-ink-secondary">
            {phraseWithNode(
              liveCwd ? t("bot.rememberedFolderNextTask") : t("bot.rememberedFolderNextTaskHome"),
              "folder",
              <span className="text-ink">{shortPath(bot.rememberedProjectCwd, home)}</span>,
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// the map loads with the Memory tab, so app start and the chat never pay for it
const MemoryMap = lazyView(() => import("./MemoryMap").then((m) => ({ default: m.MemoryMap })));
// a wide window fetches it with Bot details, so its map paints with the tab instead of after a suspend
let loadedMap: typeof import("./MemoryMap").MemoryMap | null = null;

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the bot believes. Fetched on expand, not on mount: settings opens for
 * every bot and most visits never look at memory — and an expand also
 * re-reads, so notes the bot wrote mid-session show up on the next open. */
function MemoryCard({ bot, active, warm }: { bot: Bot; active: boolean; warm: boolean }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const { run, undo } = useMemoryClean(bot.id, bot.messages, active);
  const target = active ? state.settingsMemoryTarget : null;
  const autoNotes = memoryNotesEnabled(state.config, bot);
  const [botId] = useState(bot.id);
  const [loading, setLoading] = useState(true);
  const [mapReady, setMapReady] = useState(Boolean(loadedMap));
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [status, setStatus] = useState<MemorySaveStatus>("idle");
  const [conflict, setConflict] = useState<MemoryLatest | null>(null);
  const savedFade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  // a conflict needs its buttons, so it opens the file and leaves it open
  const expanded = open || conflict !== null;
  const [wide, setWide] = useState(false);
  // where the file opens is settled when it opens, so typing never jumps between the map and the fold
  const [inMap, setInMap] = useState(false);
  const [editing, setEditing] = useState(false);
  const openFile = (next: boolean) => {
    if (next && !expanded) setInMap(wide);
    setOpen(next);
  };
  useEffect(() => {
    if (!expanded) setEditing(false);
  }, [expanded]);
  useEffect(() => {
    if (conflict) { openFile(true); setEditing(true); }
  }, [conflict]);
  // the map stays up through the pass away, so the page only folds once it is out of sight
  const up = active || warm;
  useEffect(() => {
    if (!up && !conflict) setOpen(false);
  }, [up]);
  // a collapse unmounts the editor without a blur
  useEffect(() => {
    if (active) return () => void flushMemory(botId);
  }, [active]);
  const [toFile, setToFile] = useState(0);
  const focusFile = useRef(false);
  const startEdit = (next: boolean) => {
    focusFile.current = next;
    setEditing(next);
  };
  const editFile = (next: boolean) => {
    openFile(next);
    // the file can open while memory loads, but an edit typed then would save over it
    if (next && !loading) startEdit(true);
    if (next && !wide) setToFile((count) => count + 1);
  };
  // waits for the fold: until it has grown the page may be too short to bring the file up
  useEffect(() => {
    if (!toFile) return;
    const opened = setTimeout(() => fileRow.current?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "instant" : "smooth" }), MOTION_MODERATE_MS);
    return () => clearTimeout(opened);
  }, [toFile]);
  const fileRow = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const inFold = expanded && (!inMap || !wide);
  useEffect(() => {
    if (editing && focusFile.current) card.current?.querySelector("textarea")?.focus({ preventScroll: true });
    focusFile.current = false;
  }, [editing]);
  const MapView = loadedMap ?? MemoryMap;
  const empty = !loading && !loadFailed && !text.trim() && topics.length === 0 && !currentTask(bot) && !botAsks(bot).length;

  const read = (): Promise<MemoryLatest & { truncated: boolean; topics: MemoryTopic[] }> =>
    api(`/api/bots/${botId}/memory`);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await read();
      setTruncated(result.truncated);
      setTopics(result.topics);
      const draft = openMemory(botId, result);
      setText(draft?.text ?? result.text);
      setLoadFailed(false);
      if (draft?.conflict) setConflict(result);
      else if (draft) setStatus("saving");
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    return watchMemoryArrival(botId, () => { void refresh(); });
  }, [active, botId]);
  useEffect(() => {
    if (!active || loading || !target) return;
    if ("line" in target.target && memoryTargetLine(text, target.target.line, bot.messages)) return;
    if ("cleanup" in target.target && run) return;
    fileRow.current?.closest(".overflow-y-auto")?.scrollTo({ top: 0, behavior: "instant" });
  }, [active, loading, target?.nonce, text, run]);

  const tidyRows = bot.messages.filter((message) => message.tool?.tidy).map((message) => `${message.id}:${message.tool!.tidy!.undoneAt ?? ""}`).join("|");
  useEffect(() => { if (active) void refresh(); }, [active, tidyRows]);

  // start from the newest memory, so a conflict means a real simultaneous edit
  const refresh = async () => {
    if (memoryDraft(botId) !== null) return;
    const saves = memorySaves(botId);
    const result = await read().catch(() => null);
    // a save that started after this read went out is newer than it
    if (!result || memoryDraft(botId) !== null || memorySaves(botId) !== saves) return;
    openMemory(botId, result);
    setText(result.text);
    setLoadFailed(false);
    setTruncated(result.truncated);
    setTopics(result.topics);
  };

  const edit = (next: string) => {
    setText(next);
    editMemory(botId, next);
    if (conflict) return;
    setStatus("saving");
    if (savedFade.current !== null) clearTimeout(savedFade.current);
  };

  const keepMine = (latest: MemoryLatest) => {
    setConflict(null);
    setStatus("saving");
    keepMemory(botId, latest);
  };

  const loadLatest = async (conflicted: MemoryLatest) => {
    const latest = await read().catch(() => conflicted);
    dropMemory(botId, latest);
    setConflict(null);
    setText(latest.text);
  };

  useEffect(() => {
    void load();
    // a phone keeps the lazy render, so its first tab frame stays light, but never waits on the network
    void import("./MemoryMap").then((m) => {
      if (window.innerWidth >= STACK_BELOW) { loadedMap = m.MemoryMap; setMapReady(true); }
      if (window.requestIdleCallback) window.requestIdleCallback(m.warmGlow, { timeout: 2000 });
      else m.warmGlow();
    }).catch(() => {});
  }, []);

  useEffect(() => {
    watchMemory(botId, {
      saved: (nextTruncated, pending) => {
        setTruncated(nextTruncated);
        setError(null);
        if (pending) return;
        setStatus("saved");
        savedFade.current = setTimeout(() => setStatus("idle"), 2000);
      },
      failed: (message, pending) => {
        setError(message);
        if (!pending) setStatus("failed");
      },
      conflict: (latest) => {
        setConflict(latest);
        setStatus("idle");
      },
    });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flushMemory(botId);
      else void refresh();
    };
    const onPageHide = () => void flushMemory(botId);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      if (savedFade.current !== null) clearTimeout(savedFade.current);
      // the panel is gone, so the red line under the editor is too
      watchMemory(botId, {
        saved: () => undefined,
        failed: (message) => {
          dispatch({ type: "error", message });
          setTimeout(() => dispatch({ type: "error", message: null }), 6000);
        },
        conflict: () => undefined,
      });
      void flushMemory(botId);
    };
  }, []);

  const editor = (
    <>
      {conflict && (
        <div role="alert" className="mb-3 rounded-lg border border-hairline/60 bg-inset px-3 py-2.5 text-[12px] leading-relaxed text-ink">
          <div>{t("bot.memoryConflict")}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => void loadLatest(conflict)} className={cn(ROW_BUTTON, "text-ink")}>
              {t("bot.memoryLoadLatest")}
            </button>
            <button onClick={() => keepMine(conflict)} className={cn(ROW_BUTTON, "text-ink")}>
              {t("bot.memoryKeepMine")}
            </button>
          </div>
        </div>
      )}
      <FitTextarea
        watchMetrics
        className={cn(DETAILS_INPUT, "min-h-[160px]")}
        value={text}
        placeholder={t("bot.memoryPlaceholder")}
        aria-label={t("bot.memory")}
        readOnly={loading || loadFailed}
        onChange={(e) => edit(e.target.value)}
        onFocus={() => void refresh()}
        onBlur={() => void flushMemory(botId)}
      />
      {truncated && <div className="mt-2 text-[12px] text-ink-secondary">{t("bot.memoryTruncated")}</div>}
    </>
  );
  const file = editing || loadFailed ? editor : (
    <>
      {/* the same box metrics as the editor, so Edit doesn't move the text */}
      <div className={cn("whitespace-pre-wrap break-words border border-transparent px-3 py-2 text-[13px] leading-relaxed", text ? "text-ink" : "text-ink-secondary")}>{text || t("bot.memoryPlaceholder")}</div>
      {truncated && <div className="mt-2 text-[12px] text-ink-secondary">{t("bot.memoryTruncated")}</div>}
    </>
  );
  const edits = !loading && !loadFailed && !conflict ? startEdit : undefined;

  return (
    <div ref={card} className="relative flex flex-col gap-3">
      {/* a phone's lazy map would suspend after its rows had shown, so there it still waits for the read */}
      {empty && !(expanded && inMap) ? <MemoryEmpty /> : up && (mapReady || !loading || loadFailed) && (
        <LazyView>
          <MapView bot={bot} text={text} topics={topics} target={target} active={up} loading={loading} failed={loadFailed} onRetry={() => void load()} editor={file} saveState={<SaveState status={status} />} fileAction={edits && <MemoryEditButton editing={editing} onEdit={edits} />} editing={expanded && inMap} onEditing={editFile} onStack={(stacked) => setWide(!stacked)} />
        </LazyView>
      )}
      <MemoryGroup>
        <SwitchRow
          label={t("settings.memoryNotes.toggle")}
          hint={t("settings.memoryNotes.help")}
          on={autoNotes}
          onToggle={() => dispatch({ type: "updateBot", botId: bot.id, patch: { memoryNotes: !autoNotes } })}
        />
      </MemoryGroup>
      <MemoryFile ref={fileRow} text={text} loading={loading} save={inFold ? status : undefined} open={expanded} editing={editing} onEdit={inFold ? edits : undefined} onToggle={() => openFile(!expanded)}>
        {run && <MemoryCleanRow run={run} onUndo={undo} nonce={target && "cleanup" in target.target ? target.nonce : undefined} className={expanded ? "mb-0 border-t-0" : undefined} />}
        <Fold open={inFold}>
          <div className="px-4 pb-4 pt-3">
            {loading && <div className="text-[13px] text-ink-secondary">{t("bot.memoryLoading")}</div>}
            {!loading && file}
          </div>
        </Fold>
        {error && <div className="px-4 pb-4 pt-2 text-[12px] text-danger">{error}</div>}
      </MemoryFile>
    </div>
  );
}

export function SettingsPanel({
  bot,
  closing = false,
}: {
  bot: Bot;
  closing?: boolean;
}) {
  const { state, dispatch } = useStore();
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);
  const phone = useIsPhone();
  const [slideIn] = useState(() => panelsUp === 0);
  // the shell answers the click; the rows come one commit later
  const rows = useStage(1, !slideIn);
  useEffect(() => {
    panelsUp += 1;
    return () => {
      panelsUp -= 1;
    };
  }, []);
  const restoreFocusOnClose = useRef(false);
  const avatarRequest = state.settingsAvatarRequest ?? 0;
  const [avatarOpen, setAvatarOpen] = useState(avatarRequest > 0);
  const seenAvatarRequest = useRef(0);
  const avatarSectionRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const keepGoingRequest = state.settingsKeepGoingRequest ?? 0;
  // a new Agentic Mode request (the chat header mark) lands on its row in Settings
  const [memoryAt, setMemoryAt] = useState<number | null>(null);
  const memoryRequest = state.settingsMemoryTarget?.nonce ?? 0;
  const [seenMemoryRequest, setSeenMemoryRequest] = useState(memoryRequest);
  const memoryTab = memoryAt === keepGoingRequest || memoryRequest !== seenMemoryRequest;
  useEffect(() => {
    if (!memoryRequest) return;
    setMemoryAt(keepGoingRequest);
    setSeenMemoryRequest(memoryRequest);
  }, [memoryRequest, keepGoingRequest]);
  const cover = useCoverChat(panelRef, memoryTab, closing);
  const showTab = (memory: boolean) => {
    if (memory === memoryTab) return;
    setMemoryAt(memory ? keepGoingRequest : null);
  };
  const paging = useDetailsTabs(pagesRef, phone, closing, memoryTab, showTab);
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | null>(null);
  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "color"
        | "mascotExpression"
        | "mascotStyle"
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "speakReplies"
        | "voice"
        | "composio"
        | "shareTerminalWithChat"
        | "leanStartup"
        | "projectNotes"
        | "modelSelection"
      >
    > & { acknowledgeLocalAuto?: boolean },
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const desktopTerminal = Boolean(window.ogb?.terminal);
  const serverHasTerminal = state.config?.features?.terminalHost === true;
  const terminalShared =
    bot.shareTerminalWithChat === true || (bot.shareTerminalWithChat !== false && (desktopTerminal || serverHasTerminal));
  const shareTerminalDisabled = !terminalShared && !desktopTerminal && !serverHasTerminal;
  useEffect(() => {
    if (!rows || avatarRequest === 0 || avatarRequest === seenAvatarRequest.current) return;
    seenAvatarRequest.current = avatarRequest;
    setAvatarOpen(true);
    avatarSectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [avatarRequest, rows]);

  const closeSettings = () => {
    restoreFocusOnClose.current = true;
    dispatch({ type: "toggleSettings", open: false });
  };
  useSettingsSwipe(panelRef, phone && !closing && !memoryTab, false, () => {
    hapticTick();
    // The swipe already settled offscreen; do not replay the panel exit.
    if (panelRef.current) panelRef.current.style.animation = "none";
    closeSettings();
  });

  useEffect(() => {
    if (closing) return;
    for (const key of ["animation", "transform", "opacity", "transition", "will-change"]) {
      panelRef.current?.style.removeProperty(key);
    }
    restoreFocusOnClose.current = false;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"][aria-modal="true"]')) return;
      if (panelRef.current?.querySelector("[data-model-picker-content]")) return;
      event.preventDefault();
      restoreFocusOnClose.current = true;
      dispatch({ type: "toggleSettings", open: false });
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      if (!restoreFocusOnClose.current) return;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active !== document.body && !panelRef.current?.contains(active)) return;
        const target = previousFocus && previousFocus !== document.body && previousFocus.isConnected
          ? previousFocus
          : document.querySelector<HTMLElement>("[data-orbit-composer]:not(:disabled)") ??
            document.querySelector<HTMLElement>("[data-orbit-chat-focus-fallback]");
        target?.focus();
      });
    };
  }, [closing, dispatch]);

  return (
    <>
    {/* Below md the sidebar is already a drawer, so docking here would leave a
        ~200px chat column at the window floor. Take the content area instead,
        z-30 to cover the drawer button, still under the drawer itself at z-40. */}
    <aside ref={panelRef} data-settings-panel="" data-side-panel="" data-closing={closing || undefined} inert={closing} style={cover} className={cn(slideIn && "max-md:animate-panel-in md:animate-panel-slide md:*:animate-fade-in", "relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel [&_:is(button:not(:disabled),summary)]:cursor-pointer md:data-closing:-ml-[400px] max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-full")}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={closeSettings}
          aria-label={t("bot.collapseDetails")}
          title={t("bot.collapseDetails")}
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronRight size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">{t("bot.details")}</span>
        <button
          onClick={closeSettings}
          aria-label={t("bot.closeDetails")}
          title={t("bot.closeDetails")}
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div role="tablist" aria-label={t("bot.details")} className={cn("mx-5 flex gap-1 rounded-xl bg-inset p-1", cover && "md:w-[360px] md:self-center")}>
        {([false, true] as const).map((memory) => (
          <button
            key={String(memory)}
            type="button"
            role="tab"
            aria-selected={memoryTab === memory}
            onClick={() => showTab(memory)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13.5px] transition-colors",
              memoryTab === memory ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {memory ? <MemoryCleanIcon botId={bot.id} active={memoryTab} /> : <Settings size={15} aria-hidden="true" />}
            {memory ? t("bot.memory") : t("bot.settingsTab")}
          </button>
        ))}
      </div>

      <div ref={pagesRef} className={cn("relative min-h-0 flex-1 overflow-hidden", paging && "pointer-events-none")}>
        <div hidden={memoryTab && !paging} inert={memoryTab} className="absolute inset-0 space-y-3 overflow-y-auto px-5 pb-5 pt-4">
          {rows > 0 && (
            <>
              <KeepGoingCard bot={bot} />
              <div className={DETAILS_BOX}>
                <div ref={avatarSectionRef} className={DETAILS_ROW}>
                  <div className="flex items-center gap-3">
                    <BotAvatar
                      bot={bot}
                      state={activeState}
                      size={48}
                      motion={mascotMotion?.kind ?? "none"}
                      motionKey={mascotMotion?.nonce ?? 0}
                    />
                    <div className="min-w-0 flex-1 text-[14px] font-medium text-ink">{t("bot.avatar")}</div>
                    <button
                      type="button"
                      aria-expanded={avatarOpen}
                      onClick={() => setAvatarOpen((open) => !open)}
                      className={cn(ROW_BUTTON, "text-ink")}
                    >
                      {avatarOpen ? t("bot.avatarDone") : t("bot.avatarCustomize")}
                    </button>
                  </div>
                  <Fold open={avatarOpen}>
                    <div className="mt-3">
                      <BotProfileAvatarCard
                        bot={bot}
                        activeState={activeState}
                        mascotMotion={mascotMotion}
                        onPatch={patch}
                      />
                    </div>
                  </Fold>
                </div>
                <Field label={t("bot.name")}>
                  <input
                    className={DETAILS_INPUT}
                    maxLength={BOT_PROFILE_LIMITS.name}
                    value={bot.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </Field>
                <Field label={t("bot.title")}>
                  <input
                    className={DETAILS_INPUT}
                    maxLength={BOT_PROFILE_LIMITS.title}
                    placeholder={t("bot.titlePlaceholder")}
                    value={bot.title}
                    onChange={(e) => patch({ title: e.target.value })}
                  />
                </Field>
                <Field label={t("bot.description")} hint={t("bot.descriptionHelp")} status={<SaveStatus botId={bot.id} />}>
                  <FitTextarea
                    watchMetrics
                    aria-label={t("bot.description")}
                    className={cn(DETAILS_INPUT, "min-h-[96px]")}
                    maxLength={BOT_PROFILE_LIMITS.description}
                    placeholder={t("bot.descriptionPlaceholder")}
                    value={bot.description}
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                </Field>
              </div>

              <WorkingFolder bot={bot} />

              <div className={DETAILS_BOX}>
                <div className={DETAILS_ROW}>
                  <SegmentedRow<"auto" | "ask">
                    label={t("bot.approval")}
                    value={bot.autoApprove ? "auto" : "ask"}
                    options={[
                      { id: "auto", label: t("bot.approvalAuto") },
                      { id: "ask", label: t("bot.approvalAsk") },
                    ]}
                    onChange={(id) => {
                      const auto = id === "auto";
                      if (Boolean(bot.autoApprove) === auto) return;
                      if (auto && bot.computer === "local") setLocalAutoWarning("auto");
                      else patch({ autoApprove: auto });
                    }}
                  />
                </div>
                <SwitchRow
                  label={t("bot.notifications")}
                  aria={t("bot.notificationsAria")}
                  on={bot.notifications}
                  onToggle={() => {
                    const enabled = !bot.notifications;
                    if (enabled && !window.ogb?.showNotification) void requestNotificationPermission();
                    patch({ notifications: enabled });
                  }}
                />
                {(!shareTerminalDisabled || showDisabledShareTerminal()) && (
                  <SwitchRow
                    label={t("bot.shareTerminal")}
                    hint={t("bot.shareTerminalHelp")}
                    on={terminalShared}
                    disabled={shareTerminalDisabled}
                    className="disabled:cursor-not-allowed disabled:opacity-40"
                    onToggle={() => patch({ shareTerminalWithChat: !terminalShared })}
                  />
                )}
                {showBotVoiceAndStartupSettings() && engine?.driverKind === "claudeAgent" && (
                  <SwitchRow
                    label={t("bot.leanStartup")}
                    on={bot.leanStartup !== true}
                    onToggle={() => patch({ leanStartup: !(bot.leanStartup === true) })}
                  />
                )}
              </div>

              {showBotVoiceAndStartupSettings() && <VoiceSettings bot={bot} onPatch={patch} />}
            </>
          )}
        </div>
        <div hidden={!memoryTab && !paging} inert={!memoryTab} className="absolute inset-0 overflow-y-auto px-5 pb-5 pt-4">
          {rows > 0 && <MemoryCard key={bot.id} bot={bot} active={memoryTab} warm={paging} />}
        </div>
      </div>
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        if (localAutoWarning === "auto") patch({ autoApprove: true, acknowledgeLocalAuto: true });
        setLocalAutoWarning(null);
      }}
    />
    </>
  );
}
