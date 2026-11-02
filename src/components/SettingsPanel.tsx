import { ChevronLeft, FolderOpen, X } from "lucide-react";
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
import { BotAvatar } from "./Avatar";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { MemoryFile, MemoryGroup, MemoryTask, NotedLines } from "./MemoryGroups";
import { VoiceSettings } from "./VoiceSettings";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
/** Keep a complete catalog phrase; wrap one `{name}` slot in JSX (paths stay mono). */
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

function KeepGoingRow({ bot }: { bot: Bot }) {
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
    const row = rowRef.current;
    const list = row?.parentElement;
    if (request === 0 || !row || !list) return;
    const show = () => row.scrollIntoView({ block: "nearest" });
    show();
    // Memory above loads late and pushes this row back out of view.
    const observer = new ResizeObserver(show);
    observer.observe(list);
    const stop = setTimeout(() => observer.disconnect(), 1000);
    return () => {
      clearTimeout(stop);
      observer.disconnect();
    };
  }, [request]);

  return (
    <div ref={rowRef} data-settings-keep-going className="rounded-xl bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-ink">{t("bot.keepGoing")}</div>
          <div className="mt-0.5 break-keep text-[12px] leading-relaxed text-ink-secondary">
            {paused ? t("bot.keepGoingPaused", { reason: t(KEEP_GOING_PAUSED[paused]) }) : t("bot.keepGoingHelp")}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={on}
          aria-label={t("bot.keepGoing")}
          disabled={saving}
          onClick={() => void toggle()}
          className={cn(
            "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-wait",
            on ? "bg-accent" : "bg-control",
          )}
        >
          <span
            className={cn(
              "absolute top-[3px] size-5 rounded-full bg-white transition-all",
              on ? "left-[21px]" : "left-[3px]",
            )}
          />
        </button>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
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
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("bot.workingFolder")}</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd ?? undefined}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="font-sans text-ink-secondary">{t("bot.workingFolderEmpty")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> {t("bot.workingFolderChoose")}
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("bot.workingFolderClear")}
            </button>
          )}
        </div>
      ) : (
        <WorkingFolderField value={draft ?? bot.cwd ?? ""} onChange={setDraft} onSave={() => void save((draft ?? bot.cwd ?? "").trim() || null)} disabled={saving || draft === null} />
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          {pinned
            ? phraseWithNode(
                t("bot.workingFolderPinned"),
                "folder",
                <span className="font-mono">{shortPath(pinned, home)}</span>,
              )
            : t("bot.workingFolderPinnedHome")}
        </div>
      )}
      {bot.rememberedProjectCwd && bot.rememberedProjectCwd !== liveCwd && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          {liveCwd
            ? t("bot.rememberedFolderNextTask", {
                folder: shortPath(bot.rememberedProjectCwd, home),
                current: shortPath(liveCwd, home),
              })
            : t("bot.rememberedFolderNextTaskHome", {
                folder: shortPath(bot.rememberedProjectCwd, home),
              })}
        </div>
      )}
    </div>
  );
}

interface MemoryTopic {
  name: string;
  bytes: number;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the bot believes. Fetched on expand, not on mount: settings opens for
 * every bot and most visits never look at memory — and an expand also
 * re-reads, so notes the bot wrote mid-session show up on the next open. */
function MemoryCard({ bot }: { bot: Bot }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const autoNotes = memoryNotesEnabled(state.config, bot);
  const [botId] = useState(bot.id);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);
  const [conflict, setConflict] = useState<MemoryLatest | null>(null);
  const savedFade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  // a conflict needs its buttons, so it opens the file and leaves it open
  const expanded = open || conflict !== null;
  useEffect(() => {
    if (conflict) setOpen(true);
  }, [conflict]);

  const read = (): Promise<MemoryLatest & { truncated: boolean; topics: MemoryTopic[] }> =>
    api(`/api/bots/${botId}/memory`);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
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

  const openTopic = async (name: string) => {
    void flushMemory(botId);
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
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
        if (!pending) setStatus("idle");
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

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] text-ink-secondary">
        <span>{t("bot.memory")}</span>
        <span role="status" className="text-[12px]">
          {status === "saving" ? t("bot.memorySaving") : status === "saved" ? t("bot.memorySaved") : null}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl bg-card">
        <MemoryGroup title={t("bot.memoryFromChats")}>
          <NotedLines text={text} />
          <div className="mt-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-ink">{t("settings.memoryNotes.toggle")}</div>
              <div className="mt-0.5 break-keep text-[12px] leading-relaxed text-ink-secondary">{t("settings.memoryNotes.help")}</div>
            </div>
            <button
              role="switch"
              aria-checked={autoNotes}
              aria-label={t("settings.memoryNotes.toggle")}
              onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { memoryNotes: !autoNotes } })}
              className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", autoNotes ? "bg-accent" : "bg-control")}
            >
              <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", autoNotes ? "left-[21px]" : "left-[3px]")} />
            </button>
          </div>
        </MemoryGroup>
        <MemoryTask bot={bot} />
        <MemoryFile text={text} topics={topics.length} loading={loading} open={expanded} onToggle={() => setOpen(!expanded)}>
          {expanded && (
            <div className="px-4 pb-4">
              <div className="mb-3 break-keep text-[12px] leading-relaxed text-ink-secondary">{t("bot.memoryThisBotHelp")}</div>
                {loading && <div className="text-[13px] text-ink-secondary">Loading…</div>}

                {!loading && topic && (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[12.5px] text-ink">memory/{topic.name}</span>
                      <button
                        onClick={() => setTopic(null)}
                        className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
                      >
                        Back
                      </button>
                    </div>
                    <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12.5px] leading-relaxed text-ink">
                      {topic.text}
                    </pre>
                  </div>
                )}

                {!loading && !topic && (
                  <div>
                    <textarea
                      className={cn(inputCls, "min-h-[160px] resize-y font-mono text-[12.5px] leading-relaxed")}
                      value={text}
                      placeholder={t("bot.memoryPlaceholder")}
                      aria-label={t("bot.memory")}
                      readOnly={loadFailed}
                      onChange={(e) => edit(e.target.value)}
                      onFocus={() => void refresh()}
                      onBlur={() => void flushMemory(botId)}
                    />
                    {conflict && (
                      <div role="alert" className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
                        <div>{t("bot.memoryConflict")}</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button onClick={() => void loadLatest(conflict)} className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover">
                            {t("bot.memoryLoadLatest")}
                          </button>
                          <button onClick={() => keepMine(conflict)} className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover">
                            {t("bot.memoryKeepMine")}
                          </button>
                        </div>
                      </div>
                    )}
                    {truncated && (
                      <div className="mt-2 text-[11.5px] text-ink-secondary">
                        Only the top loads each turn.
                      </div>
                    )}
                    {topics.length > 0 && (
                      <div className="mt-3">
                        <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                          Topic files
                        </div>
                        <div className="overflow-hidden rounded-lg border border-hairline/40">
                          {topics.map((entry) => (
                            <button
                              key={entry.name}
                              onClick={() => void openTopic(entry.name)}
                              className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60"
                            >
                              <span className="truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
                              <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

            </div>
          )}
          {(loadFailed || error) && (
            <div className="px-4 pb-4">
                {loadFailed && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] text-danger">
                    {t("bot.memoryLoadFailed")}
                    <button
                      onClick={() => void load()}
                      className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
                    >
                      {t("bot.memoryRetry")}
                    </button>
                  </div>
                )}
                {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
            </div>
          )}
        </MemoryFile>
      </div>
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
  const restoreFocusOnClose = useRef(false);
  const avatarRequest = state.settingsAvatarRequest ?? 0;
  const [avatarOpen, setAvatarOpen] = useState(avatarRequest > 0);
  const seenAvatarRequest = useRef(0);
  const avatarSectionRef = useRef<HTMLDivElement>(null);
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
    if (avatarRequest === 0 || avatarRequest === seenAvatarRequest.current) return;
    seenAvatarRequest.current = avatarRequest;
    setAvatarOpen(true);
    avatarSectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [avatarRequest]);

  const closeSettings = () => {
    restoreFocusOnClose.current = true;
    dispatch({ type: "toggleSettings", open: false });
  };

  useEffect(() => {
    if (closing) return;
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
    <aside ref={panelRef} data-settings-panel="" data-closing={closing || undefined} inert={closing} className="animate-panel-in relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={closeSettings}
          aria-label={t("bot.collapseDetails")}
          title={t("bot.collapseDetails")}
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
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

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          <div ref={avatarSectionRef} className="rounded-xl bg-card p-3">
            <div className="flex items-center gap-3">
              <BotAvatar
                bot={bot}
                state={activeState}
                size={48}
                motion={mascotMotion?.kind ?? "none"}
                motionKey={mascotMotion?.nonce ?? 0}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium text-ink">{t("bot.avatar")}</div>
              </div>
              <button
                type="button"
                aria-expanded={avatarOpen}
                onClick={() => setAvatarOpen((open) => !open)}
                className="rounded-lg bg-control px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover"
              >
                {avatarOpen ? t("bot.avatarDone") : t("bot.avatarCustomize")}
              </button>
            </div>
            {avatarOpen && (
              <div className="mt-3">
                <BotProfileAvatarCard
                  bot={bot}
                  activeState={activeState}
                  mascotMotion={mascotMotion}
                  onPatch={patch}
                />
              </div>
            )}
          </div>

          <Field label={t("bot.name")}>
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label={t("bot.title")}>
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder={t("bot.titlePlaceholder")}
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label={t("bot.description")}>
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder={t("bot.descriptionPlaceholder")}
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <MemoryCard key={bot.id} bot={bot} />
          <WorkingFolder bot={bot} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("bot.approval")}</div>
            <div role="radiogroup" aria-label={t("bot.approval")} className="flex gap-1 rounded-full bg-inset p-0.5">
              {([true, false] as const).map((auto) => (
                <button
                  key={String(auto)}
                  type="button"
                  role="radio"
                  aria-checked={Boolean(bot.autoApprove) === auto}
                  onClick={() => {
                    if (Boolean(bot.autoApprove) === auto) return;
                    if (auto && bot.computer === "local") setLocalAutoWarning("auto");
                    else patch({ autoApprove: auto });
                  }}
                  className={cn(
                    "rounded-full px-3 py-1 text-[13px] font-medium",
                    Boolean(bot.autoApprove) === auto ? "bg-accent text-accent-ink" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {auto ? t("bot.approvalAuto") : t("bot.approvalAsk")}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">{t("bot.notifications")}</div>
            </div>
            <button
              role="switch"
              aria-checked={bot.notifications}
              aria-label={t("bot.notificationsAria")}
              onClick={() => {
                const enabled = !bot.notifications;
                if (enabled && !window.ogb?.showNotification) void requestNotificationPermission();
                patch({ notifications: enabled });
              }}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.notifications ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.notifications ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          {(!shareTerminalDisabled || showDisabledShareTerminal()) && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
              <div>
                <div className="text-[15px] font-medium text-ink">{t("bot.shareTerminal")}</div>
              </div>
              <button
                role="switch"
                aria-checked={terminalShared}
                aria-label={t("bot.shareTerminal")}
                disabled={shareTerminalDisabled}
                onClick={() => patch({ shareTerminalWithChat: !terminalShared })}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  terminalShared ? "bg-accent" : "bg-control",
                )}
              >
                <span
                  className={cn(
                    "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                    terminalShared ? "left-[21px]" : "left-[3px]",
                  )}
                />
              </button>
            </div>
          )}

          <KeepGoingRow bot={bot} />

          {showBotVoiceAndStartupSettings() && (
            <>
          {engine?.driverKind === "claudeAgent" && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
              <div>
                <div className="text-[15px] font-medium text-ink">{t("bot.leanStartup")}</div>
              </div>
              <button
                role="switch"
                aria-checked={bot.leanStartup !== true}
                aria-label={t("bot.leanStartup")}
                onClick={() => patch({ leanStartup: !(bot.leanStartup === true) })}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                  bot.leanStartup !== true ? "bg-accent" : "bg-control",
                )}
              >
                <span
                  className={cn(
                    "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                    bot.leanStartup !== true ? "left-[21px]" : "left-[3px]",
                  )}
                />
              </button>
            </div>
          )}

          <VoiceSettings bot={bot} onPatch={patch} />
            </>
          )}

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
