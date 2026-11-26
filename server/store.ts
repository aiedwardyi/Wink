// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { setAsideFile, writeFileAtomic } from "./atomic.ts";
import type { BotHooks } from "./bot-hooks.ts";
import { TrashList } from "./bot-trash.ts";
import { indexMailRow, rebuildMailIndex } from "./mail-index.ts";
import type { UsageWaitView } from "./limit-wait-store.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import { DATA_DIR } from "./config.ts";
import { defaultComputerForNewBot } from "./local-routing.ts";
import * as mdb from "./message-db.ts";
import type { SyncChange, SyncMutation } from "./thread-sync-v2.ts";
import { syncPathChanged } from "./thread-sync-path.ts";
import { THREAD_CACHE_CHARS, ThreadCache, type ThreadState } from "./thread-cache.ts";
import type { ToolDetail } from "../shared/tool-detail.ts";
import { latestTaskAsks } from "../shared/task-ask-list.ts";
import { removeWorkspace } from "./workspace.ts";
import { readSessionSystem, SESSION_SYSTEM_DIR, sessionSystemFile, writeSessionSystem } from "./session-system.ts";
import { newId, type CloudBackend, type ModelSelection, type ThreadId } from "./contracts.ts";
import { pickBotName } from "./names.ts";
import { applyPendingModel } from "./pending-model.ts";
import { clearAccountSessions } from "./account-sessions.ts";
import { validateProjectNotes } from "./project-notes.ts";
import { redactSecretsInText } from "./redact.ts";
import { noticeText } from "./rooms/db.ts";
import { coalescedSave } from "./save-defer.ts";
import { redactToolMessage } from "./tool-detail.ts";
import { isOpenAsk, type TaskAsk } from "./task-asks.ts";
import { redactVerifyCard } from "./verify-message.ts";
import type { NativePrompt, ResumeSeed } from "./turn-context.ts";
import {
  deleteTaskResumePacket,
  readTaskResumePacket,
  settleTaskResumePacket,
  stageTaskResumePacket,
  writeTaskResumePacket,
  type TaskResumePacket,
} from "./task-state.ts";
import { logDroppedAsks } from "./task-dropped.ts";
import { lastUserInstruction, packetAfterInterruption } from "./task-recovery-flush.ts";
import {
  botAvatarChoiceSchema,
  botAvatarProfile,
  nextWinkAvatar,
  type BotAvatarChoice,
  type BotAvatarCrop,
} from "../shared/bot-avatar.ts";
import type { RoutineRequestCardData } from "../shared/routine-request.ts";
import type { RoutineRunCardData } from "../shared/routine-run.ts";
import type { CallPrefs } from "../shared/live-call.ts";
import type { VerifyCardData } from "../shared/live-verify.ts";
import { readContextCompaction, type ContextCompactionV1 } from "../shared/context-compaction.ts";

export type MausColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral"
  | "white"
  | "black"
  | "gray";

/**
 * The face a bot rests on, as one of the engine's state names. Kept as a plain
 * string rather than a union: bots saved under the app's earlier ten-face
 * vocabulary still carry those names, and the client resolves both on read.
 */
export type MausExpression = string;

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  /** a provider question's typed answer; `answered` holds only "answer" */
  answerText?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** A bot's non-blocking ask_user question; never has a requestId. */
  askUser?: true;
  /** an ask_user card that waits until answered; older ones closed when typed past */
  staysOpen?: true;
  /** an ask_user card: the asking turn's last text; absent when that turn wrote none */
  replyId?: string;
  /** permission cards: the tool being requested, so the card can show what
   * is actually being asked and offer "always allow this tool". */
  tool?: string;
  /** why this stopped despite auto mode (destructive-looking command) */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  /** Local actions never share remembered grants with cloud/tool approvals. */
  approvalScope?: "local-computer";
  /** A durable chat-created routine proposal. The scheduler only applies it
   * after this card is explicitly confirmed by the user. */
  routineRequest?: RoutineRequestCardData;
}

export interface ConnectorCardData {
  /** Composio toolkit slug. It is validated server-side before every action. */
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  /** Cards created by one agent request resume together after all connect. */
  resumeKey: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  /** Fixed allowlisted credential id; never an arbitrary config path. */
  target: import("../shared/credential-request.ts").CredentialId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  /** Custom keys only: the site the saved key is locked to. */
  service?: import("../shared/credential-request.ts").CustomService;
  provided?: boolean;
  dismissed?: boolean;
  resumed?: boolean;
  error?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "routine.run" | "compaction" | "note" | "launch";
  text?: string;
  mailbox?: { key: string };
  /** Versioned model-context state. Unknown versions stay intact on disk. */
  compaction?: unknown;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** One idempotently updated status card in the conversation that created a
   * routine. The actual provider turn remains in its isolated task. */
  routineRun?: RoutineRunCardData;
  /** note messages: the bot's current Live Verify card. */
  verify?: VerifyCardData;
  /** activity messages: tool name + outcome. `spoken` is the same chip as
   * a phrase a voice can read ("reading a file") — computed once here so
   * call mode never has to re-derive it from the raw tool name, and absent
   * for chips not worth interrupting the ear for. */
  /** `setup` marks an error the user fixes by installing or configuring
   * something — the UI offers setup instead of a retry that cannot work. */
  tool?: {
    name: string;
    memoryBotId?: string;
    /** Claude Code tool name, when the engine said the kind. */
    verb?: string;
    ok?: boolean;
    spoken?: string;
    summary?: string;
    durationMs?: number;
    detail?: ToolDetail;
    /** files a successful call wrote, as the engine named them */
    writes?: string[];
    setup?: boolean;
    signIn?: boolean;
    accountId?: string;
    folder?: string;
    usageLimit?: { resetsAt: number | null; model?: boolean };
    usageWait?: UsageWaitView;
    /** an auto-approval chip; the model replay skips it */
    approval?: boolean;
    /** Sleep's morning line: the run it archived and how many lines */
    tidy?: { runId: string; count: number; undoneAt?: number };
  };
  /** user messages sent INTO a running turn (capabilities.queueing): the
   * model saw it mid-turn, so the transcript marks it — a reader should
   * know the reply above it may already account for this line */
  steered?: boolean;
  /** Quick helper rows: an ask sent while the bot worked, its answer, or an ask handed to the bot. */
  quick?: { state: "asked" | "answer" | "handoff"; askId?: string; noted?: true };
  /** A hidden 1:1 row: what the bot said in a room, carried into its next 1:1 turn once. */
  roomEcho?: { groupId: string; noted?: true };
  /** The engine replaced a longer mid-turn note with this short text. */
  summarized?: boolean;
  /** Hidden: a later text of its turn says the same, so replay skips it. */
  restated?: true;
  /** The reply of a new bot's offer turn that carries the Import Memory prompt; the provider buttons show only here. */
  importOffer?: true;
  /** Bot replies: the engine driver kind that wrote it; older rows have none. */
  engine?: string;
  call?: import("../shared/live-call.ts").CallTag;
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  /** a screen message published by show_image: never pruned, always shown */
  shown?: boolean;
  /** show_image: the attachment name its pixels load from */
  image?: string;
  /** wire only: pixels load from the message image route */
  hasImage?: boolean;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** Optional flat reply reference. Unlike parentId this never changes the
   * conversation branch; it only quotes one earlier text message inline. */
  replyToId?: string;
  /** Stable client identity for at-most-once chat POST retries. */
  sendId?: string;
  /** group threads: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: string; chiefOfStaff?: boolean };
  /** group threads: the member whose question card this user line answers; recovery reads who it was for. */
  askedBy?: string;
  /** A tapped choice's line: the ask_user card it answers. */
  answersCard?: string;
  /** When the person acted, before card persistence or a queue delayed delivery. */
  actedAt?: number;
  /** Waited below the turn (after this turn, sync hold, Send now): drawn where it landed, not by actedAt. */
  waited?: boolean;
  /** One past every send the sending window knew: orders two lines the server stamped alike. */
  sendSeq?: number;
  /** Last transcript row visible at send time, or null for an empty transcript. */
  sentAfterId?: string | null;
  origin?: string;
  /** Team room rows: who said it, and the room log entry it mirrors. */
  author?: import("./rooms/db.ts").RoomAuthor;
  roomEntryId?: string;
  roomFiles?: import("./rooms/db.ts").RoomFile[];
  quiet?: true;
  snagIds?: string[];
  reportIds?: string[];
  noteType?: "team-report";
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Message to @X" in the caller's chat, linking to the
   * bot⇄bot channel where the exchange is mirrored. `peer` marks a chip's role:
   * "message" and "reply" carry the sent message or the reply as `text`, except
   * a "message" chip in the channel itself, which shows it already; "from" is the
   * receiving side's chip and has none. */
  comm?: {
    groupId: string; withBotId: string; withName: string; withColor: string;
    peer?: "message" | "reply" | "from"; wake?: true;
    taskId?: string;
    mailKey?: string;
    deliver?: "queued" | "now";
    state?: import("./mail-types.ts").MailState;
    read?: import("./mail-types.ts").MailRead;
  };
  /** user messages sent while the bot was mid-turn, waiting in the
   * steer-queue to auto-send on settle. Cleared when the drain consumes
   * them; a true stranded by a restart is inert because the client only
   * shows the affordance while the bot is busy. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. The client pending
   * chip matches on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** One independent conversation inside a user-created channel. Channel
 * membership and instructions stay on GroupRecord; transcript-bound state
 * lives here so switching tasks never moves a pin or working directory into
 * another provider context. */
export interface GroupTaskRecord {
  threadId: ThreadId;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
}

/** A room: a shared thread where several bots + the user talk. Plain
 * messages follow `defaultResponder`; explicit @mentions always override it.
 * The bulletin is the room's shared instructions — every member's turn gets
 * it as part of its system prompt. */
/** A team room's pinned line; `by` is "host" or "person:<id>". */
export interface RoomNotice {
  entryId: string;
  by: string;
  at: number;
  /** The line's text, for viewers whose loaded lines no longer reach it. */
  text?: string;
}

export interface GroupRecord {
  picture?: string;
  notice?: RoomNotice;
  id: string;
  /** The active task's thread. Direct-message channels remain single-threaded. */
  threadId: ThreadId;
  /** User-created channels have independent tasks, newest first. */
  tasks?: GroupTaskRecord[];
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  /** When unread last cleared; rows count replies after it. */
  readAt?: number;
  createdAt: number;
  /** true for auto-created bot⇄bot channels (ask_bot exchanges live here;
   * the user can open the channel and chip in) */
  dm?: boolean;
  /** A team room this PC hosts; its people and log live in rooms.db. */
  hosted?: { roomId: string };
  /** transient: the member currently running a turn (never persisted) */
  busyBotId?: string | null;
  /** the room's shared desk: where member turns run their shell tools,
   * overriding each member's own folder. The room pins its own copy on its
   * first turn (pinnedCwd). Absent = each member's own default. */
  cwd?: string;
  /** Compatibility mirror of the active task's pinned folder. */
  pinnedCwd?: string | null;
  /** Compatibility mirror of the active task's pinned message. */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under; shares the bots'
   * namespace so one heading can hold a project's room and its people */
  section?: string;
  pinned?: boolean;
  /** New rooms start with setup skipped, so older builds skip the setup page
   * too; both null is a room still pending from before. Records from before
   * room setup existed omit both keys and remain immediately usable. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
}

/** One task = one conversation with its own context.
 *
 * A bot used to be a single endless thread, which meant every job
 * contaminated the next and the only way to get a clean slate was to
 * clone the bot. A task is that clean slate: its own thread, its own
 * transcript, and — the part that actually matters — its own provider
 * session. Sharing resume cursors between tasks would resume the other
 * task's session and quietly undo the whole thing. */
export interface TaskRecord {
  threadId: ThreadId;
  mailUnread?: string[];
  title: string;
  createdAt: number;
  /** provider-native continuation per instance, for THIS task only */
  resumeCursors: Record<string, unknown>;
  /** which instance dispatched the most recent turn. A cursor alone can't
   * say whether an engine's session is current — another engine may have
   * taken turns since — so this is what decides an inline replay. Absent
   * on tasks from before the field existed. */
  lastInstanceId?: string;
  /** model used by the most recent dispatch; absent on older tasks */
  lastModel?: string;
  /** what this task has spent: banked once per turn from turn.completed */
  usage?: TaskUsage;
  /** the folder this task's turns run in, pinned on its first turn from
   * the bot's `cwd` at that moment. Pinned, not read live: Claude keeps
   * sessions per project directory and Codex threads carry their cwd, so
   * a folder that moved under a live session would break resume. `null`
   * = pinned to the default (home); absent = not pinned yet. */
  cwd?: string | null;
  /** User message that last recycled the provider session. Settled tools
   * after this id belong to the current native session; older chips do
   * not. Absent on tasks that have never soft-recycled. */
  providerSessionBoundId?: string;
  /** The session a turn certified. Counts only while `resumeCursors` still
   * holds that instance's cursor; absent means no session may be resumed
   * before a replay. */
  resumeSeed?: ResumeSeed;
  /** Newest pane note a dispatched turn carried; `null` once tracked with
   * none yet. Absent on tasks from before the field existed. */
  paneNotesDeliveredId?: string | null;
  /** Reaction marks (`reactionMarkKeys`) the last dispatched turn was told
   * about. Absent on tasks from before the field existed. */
  reactionsDelivered?: string[];
  /** Newest pane note a skipped wake settled. Only the startup re-arm reads
   * it; the next turn still carries the note. */
  paneNotesSkippedId?: string;
  /** Prompt sizes the engine last reported, for the session named by its
   * cursor. Says nothing once `resumeCursors` no longer holds that cursor. */
  nativePrompt?: NativePrompt;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** The part of `input` the provider served from its prompt cache — context
   * the model re-read rather than fresh text. Every turn resends the whole
   * conversation plus the system prompt and tool schemas, so on a chatty
   * thread this is most of `input`. Absent on records from older builds. */
  cachedInput?: number;
  /** Last settled turn's reported input tokens — the native session size
   * signal used to recycle a fat CLI session before the first compact.
   * Absent on older records and on turns that reported no tokens. */
  lastInput?: number;
  /** null until any turn reports a cost — most engines never do. Records
   * written by builds before cost existed lack the field; read as null. */
  costUsd: number | null;
  turns: number;
}

/** Everything the BOT authored is scrubbed of content-shaped secrets before
 * it is stored: its reply text, a tool title (an ACP engine's title can be
 * the whole command line), a permission card's summary. What the user typed
 * is theirs and stays as typed. Stored, not just displayed: the transcript
 * is replayed into every rebuild, and a leaked key would otherwise be
 * permanent. */
export function redactBotAuthored<T extends Omit<Message, "id" | "at"> & { at?: number }>(message: T): T {
  message = redactToolMessage(message);
  // A peer message lands in the recipient's transcript as role "user", so the
  // presence of `from`, not the role, decides who authored it. Test presence
  // rather than a truthy botId: this predicate must never fail open.
  if (message.role !== "bot" && !message.from) return message;
  const out = { ...message };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  const compaction = readContextCompaction({ value: out.compaction });
  if (compaction.status === "valid") {
    out.compaction = { ...compaction.value, summary: redactSecretsInText(compaction.value.summary) };
  }
  if (out.tool) {
    out.tool = {
      ...out.tool,
      ...(typeof out.tool.name === "string" ? { name: redactSecretsInText(out.tool.name) } : {}),
      // Spoken lines are derived from the raw tool title (item.started).
      // Scrub them too — the bus no longer pre-redacts titles, and hydrate
      // / voice read this field from disk, not from the live SSE frame.
      ...(typeof out.tool.spoken === "string" ? { spoken: redactSecretsInText(out.tool.spoken) } : {}),
      ...(typeof out.tool.summary === "string" ? { summary: redactSecretsInText(out.tool.summary) } : {}),
    };
  }
  if (out.routineRun) {
    const routineRun = { ...out.routineRun };
    routineRun.routineName = redactSecretsInText(routineRun.routineName);
    if (routineRun.instruction) routineRun.instruction = redactSecretsInText(routineRun.instruction);
    if (routineRun.summary) routineRun.summary = redactSecretsInText(routineRun.summary);
    if (routineRun.error) routineRun.error = redactSecretsInText(routineRun.error);
    out.routineRun = routineRun;
  }
  if (out.verify) out.verify = redactVerifyCard(out.verify);
  if (out.card) {
    const card = { ...out.card } as OptionCardData & { summary?: string };
    card.title = redactSecretsInText(card.title);
    if (typeof card.subtitle === "string") card.subtitle = redactSecretsInText(card.subtitle);
    if (typeof card.summary === "string") card.summary = redactSecretsInText(card.summary);
    if (typeof card.held === "string") card.held = redactSecretsInText(card.held);
    // `options` carry the model's own ask_user choices; `tool` its name for
    // them. The grant "always allow" matches on card.allowKey, not on these.
    if (typeof card.tool === "string") card.tool = redactSecretsInText(card.tool);
    if (Array.isArray(card.options)) card.options = card.options.map(redactSecretsInText);
    // Routine definitions are executable bot-authored text stored behind the
    // visible summary. Scrub the durable payload too so nesting it on a card
    // cannot bypass the transcript's secret-redaction boundary.
    if (card.routineRequest) {
      const operation = card.routineRequest.operation;
      card.routineRequest = {
        ...card.routineRequest,
        operation: operation.action === "create"
          ? {
              ...operation,
              routine: {
                ...operation.routine,
                name: redactSecretsInText(operation.routine.name),
                instructions: redactSecretsInText(operation.routine.instructions),
              },
            }
          : operation.action === "update"
            ? {
                ...operation,
                changes: {
                  ...operation.changes,
                  ...(typeof operation.changes.name === "string"
                    ? { name: redactSecretsInText(operation.changes.name) }
                    : {}),
                  ...(typeof operation.changes.instructions === "string"
                    ? { instructions: redactSecretsInText(operation.changes.instructions) }
                    : {}),
                },
              }
            : { ...operation },
      };
    }
    out.card = card;
  }
  if (out.connector) {
    out.connector = {
      ...out.connector,
      label: redactSecretsInText(out.connector.label),
      description: redactSecretsInText(out.connector.description),
      error: out.connector.error ? redactSecretsInText(out.connector.error) : undefined,
    };
  }
  if (out.secret) {
    out.secret = {
      ...out.secret,
      label: redactSecretsInText(out.secret.label),
      description: redactSecretsInText(out.secret.description),
      error: out.secret.error ? redactSecretsInText(out.secret.error) : undefined,
    };
  }
  return out;
}

/** What changed, emitted by the store itself right after each write. The
 * server maps these onto its SSE frames in ONE place, so no mutation path
 * can persist without the app hearing about it — the two-write-paths bug
 * (persist without emit → UI drifts; emit without persist → a restart
 * loses what the user just watched) is closed by construction. Bot and
 * group changes carry only the id: the wire shape (cursor stripping) is
 * the caller's business. */
export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
/** The states in which the bot cannot take a new message. */
export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

/** Store.rowMark: a loaded thread's row count, or an unloaded one's newest stored rowid. */
export type RowMark = { count: number } | { after: number };

export type StoreChange =
  | { type: "message"; threadId: string; message: Message; imported?: true }
  | { type: "message.patch"; threadId: string; message: Message }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "task.packet"; threadId: string }
  | { type: "bot"; botId: string; switched?: true }
  | { type: "bot.deleted"; botId: string }
  | { type: "bots.order"; botIds: string[] }
  | { type: "groups.order"; groupIds: string[] }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string; hosted?: true };

/** What a task is called before its first message names it. */
export const UNTITLED_TASK = "New task";

/** A task's name, taken from the first thing you asked it to do. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}

export interface BotRecord {
  id: string;
  /** the ACTIVE task's thread — everything that runs a turn reads this */
  threadId: ThreadId;
  /** every task this bot has, newest first */
  tasks?: TaskRecord[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: MausExpression | null;
  /** A legacy recolorable face or a fixed built-in pack icon. */
  mascotStyle?: BotAvatarChoice;
  /** App-owned attachment served as this bot's custom profile image. */
  avatarUrl?: string;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  /** When unread last cleared; rows count replies after it. */
  readAt?: number;
  modelSelection: ModelSelection;
  /** Picked mid-reply; becomes modelSelection when the bot goes idle. */
  pendingModelSelection?: ModelSelection;
  /** Skip user skills, plugins and plugin MCP servers at startup. Off unless on. */
  leanStartup?: boolean;
  hooks?: BotHooks;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** which computer the bot acts on: its cloud box, Local VM, this machine
   * (local CUA), or none. Unset = auto (box when it exists, else local when
   * available). Packaged Windows first-run defaults to off so chat does not
   * require a container runtime. */
  computer?: "cloud" | "vm" | "local" | "off";
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Auto mode may prepare/start this bot's managed VPS container. Off by
   * default because starting remote infrastructure is an external action. */
  autoStartVps?: boolean;
  /** where NEW tasks run their shell tools; each task pins its own copy
   * on its first turn (TaskRecord.cwd). Absent = resolve from chat, then
   * last remembered project, then the private bot workspace. */
  cwd?: string;
  /** The notes file a teacher bot keeps current; adds one prompt line when set. */
  projectNotes?: string;
  /** Soft last project resolved from chat when this bot had no pin.
   * Not a pin and not Settings — an explicit `cwd` still wins.
   * Cleared when chat rules that folder out, and when Settings Clear
   * drops the pin so the next task is the private workspace. */
  lastProjectCwd?: string;
  /** GitHub repos of the bot's pane origin remotes, where a bare "PR n" is looked up when the folder is not a repo. */
  knownRepos?: string[];
  /** When Settings Clear last dropped the folder. Chat lines from before it
   * are spent: no later turn may re-derive the cleared folder from them. */
  projectFolderClearedAt?: number;
  /** Auto mode: the bot approves its own tool permissions and keeps
   * working instead of stopping to ask. Questions it asks YOU still come
   * through, and a short list of destructive commands still stops it. */
  autoApprove?: boolean;
  /** Optional model review of otherwise undecided, attended approval cards.
   * Unknown persisted values are treated as off by the review boundary. */
  autoReview?: "off" | "shadow" | "enforce";
  /** Tools this bot may always use without asking, even outside auto mode
   * (set by "Always allow" on an approval card). */
  alwaysAllow?: string[];
  /** Speak this bot's replies aloud as they settle, without being asked.
   * Off by default: a hosted voice costs money per character, so speaking
   * is something you turn on, never something that happens to you. */
  speakReplies?: boolean;
  /** This bot's own voice id, so a room of bots doesn't sound like one
   * person. Falls back to the app-wide voice in config. */
  voice?: string;
  call?: CallPrefs;
  /** true after an edit/branch-switch rewound the visible conversation:
   * provider sessions still hold the abandoned branch, so the next turn
   * must start fresh (drop cursors) and replay the surviving path. */
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  /** Optional labeled divider used to organize this bot in the sidebar. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread; a pin
   * that no longer resolves (branch switched away, deleted) renders nothing */
  pinnedMessageId?: string;
  /** The coordinator for this bot's sidebar section. The store enforces
   * at most one Chief per section (including the unsectioned area). */
  chiefOfStaff?: boolean;
  /** Pause for human approval before this bot talks to a peer (ask_bot,
   * delegate_bot). Off by default: a chief-of-staff-style bot is most
   * useful when it can coordinate without nagging. */
  approvePeerComms?: boolean;
  /** Background notes from chat into MEMORY.md. Unset follows features.memoryNotes. */
  memoryNotes?: boolean;
  /** Whether this bot may use the workspace's connected apps (Composio).
   * Unset/true = allowed (the user configured the key deliberately);
   * false = this bot never receives the connection. Imported team members
   * start false — a shared persona must not reach the user's Gmail on
   * turn one. */
  composio?: boolean;
  /** Legacy browser profile still echoed to existing clients. */
  browserProfile?: string;
  /** Allow this bot's provider to read its own Orbit terminal screen. */
  shareTerminalWithChat?: boolean;
  /** Local pause until the next user message; worker reports remain in the thread. */
  paneWakePaused?: boolean;
  /** Public, package-authored playbooks installed for this bot. They carry
   * process guidance only—never executable code, credentials, or grants. */
  playbooks?: InstalledPlaybook[];
  /** Listing provenance and connector intent retained for package details
   * and future re-export. It never means the apps are authorized. */
  installedPackage?: InstalledPackageMetadata;
  /** Derived from `activity` — kept so the 200+ readers across the app and
   * tests keep working unchanged. Write through setActivity(), never here. */
  busy?: boolean;
  /** What the bot is doing right now, as the harness sees it. `busy` alone
   * could not tell working from waiting-on-you from a stalled engine.
   * Transient like busy: reset to idle on load. */
  activity?: BotActivity;
  /** Exact 1:1 task owned by a busy turn, persisted only for crash recovery. */
  activeThreadId?: ThreadId;
  createdAt: number;
}

export interface InstalledPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
}

export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release: string;
  requiredApps: Array<{ slug: string; label: string; reason: string; optional?: boolean }>;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
const fileMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

/** Sections are persisted as display labels, so exact trimmed labels are
 * their identity. Missing/blank means the unsectioned (General) team. */
export const sectionKey = (section?: string | null): string => section?.trim() || "";

/** Every visible bot but `self`, its own section first. */
export function agentRoster<T extends { id: string; hidden?: boolean; section?: string }>(bots: T[], self: T): T[] {
  const peers = bots.filter((bot) => bot.id !== self.id && !bot.hidden);
  const home = (bot: T) => sectionKey(bot.section) === sectionKey(self.section);
  return [...peers.filter(home), ...peers.filter((bot) => !home(bot))];
}

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, the name must end on a word boundary (so "@New Bottle" never matches
 * "New Bot"), names match case-insensitively, longest name wins (so
 * "@New Bot 2" never half-matches "New Bot"), hidden bots skipped, results
 * deduped. Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest[name.length]; // must not run into a longer word
      return after === undefined || !/[a-z0-9]/i.test(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Normalize persisted or API-provided routing. Old rooms did not have this
 * field; giving them their first member as lead fixes the old silent-send
 * behavior without making every prompt fan out to every model. */
export function normalizeGroupDefaultResponder(
  value: unknown,
  memberIds: string[],
  dm = false,
): GroupDefaultResponder {
  if (dm) return { kind: "mentions" };
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; botId?: unknown };
    if (candidate.kind === "everyone") return { kind: "everyone" };
    if (candidate.kind === "mentions") return { kind: "mentions" };
    if (
      candidate.kind === "member" &&
      typeof candidate.botId === "string" &&
      memberIds.includes(candidate.botId)
    ) {
      return { kind: "member", botId: candidate.botId };
    }
  }
  if (memberIds.length === 0) return { kind: "mentions" };
  return { kind: "member", botId: memberIds[0] };
}

/** Resolve the bots invoked by a human room message. Explicit targets win,
 * then the member it replies to; otherwise the room policy chooses one
 * member, everyone, or nobody. A reply to an archived member or a
 * teammate's bot wakes nobody here, as a guest's does. */
export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  defaultResponder: GroupDefaultResponder,
  replyTo?: Pick<Message, "from" | "author">,
): T[] {
  const available = members.filter((member) => !member.hidden);
  if (/(?:^|\s)@everyone\b/i.test(text)) return available;
  const mentioned = mentionedBots(text, available);
  if (mentioned.length) return mentioned;
  const replied = members.find((member) => member.id === replyTo?.from?.botId);
  if (replied) return replied.hidden ? [] : [replied];
  if (replyTo?.author?.owner) return [];
  if (defaultResponder.kind === "everyone") return available;
  if (defaultResponder.kind === "member") {
    const lead = available.find((member) => member.id === defaultResponder.botId);
    return lead ? [lead] : [];
  }
  return [];
}

/** Root-to-leaf rows by parent links. A row's id is unique in its chat (the table's key), and a parent is stored
 * before its children, so the walk reads back through the rows once and builds an id map only for one that is not. */
function walkPath(messages: readonly Message[], leafId: string | null): Message[] {
  const path: Message[] = [];
  let byId: Map<string, Message> | undefined;
  let at = messages.length;
  for (let id = leafId; id; ) {
    let row: Message | undefined;
    if (!byId) {
      let index = at - 1;
      while (index >= 0 && messages[index]!.id !== id) index--;
      if (index >= 0) row = messages[(at = index)];
    }
    row ??= (byId ??= new Map(messages.map((m) => [m.id, m]))).get(id);
    if (!row) break;
    path.push(row);
    id = row.parentId ?? null;
  }
  return path.reverse();
}

export class Store {
  bots: BotRecord[] = [];
  /** "missing" is a lost file; "unreadable" is there but did not load, so it may still hold good bots. */
  botsFile: "loaded" | "missing" | "unreadable" = "loaded";
  groups: GroupRecord[] = [];
  groupsFile: "loaded" | "missing" | "unreadable" = "loaded";
  readonly trash = new TrashList();
  /** Lists that were there but did not load; the first save moves each aside instead of writing over it. */
  private unloaded = new Set<string>();
  private threads: ThreadCache;
  /** Chats a find or jump answered from disk, where the old ones loaded them, with the head that load held: it stays until a head is stored. */
  private foundOnDisk = new Map<string, string | null>();
  /** Threads a driver still owns after Stop marked its bot idle; the cache keeps them. */
  private heldThreads: () => Iterable<string> = () => [];
  private taskPackets = new Map<string, TaskResumePacket | null>();
  private defaultSelection: () => ModelSelection;
  private listeners = new Set<(change: StoreChange) => void>();
  private writeListeners = new Set<(threadId: string) => void>();
  private syncWrite?: (threadId: string, mutations: SyncMutation[], write: () => void) => void;
  private syncImport = false;
  private coalesce: boolean;
  private botsSave = coalescedSave(() => {
    this.saveList(BOTS_FILE, JSON.stringify(this.bots, null, 2));
    this.pruneSessionSystems();
  });

  constructor(defaultSelection: () => ModelSelection, opts: { coalesceSaves?: boolean; threadCacheChars?: number } = {}) {
    this.threads = new ThreadCache(opts.threadCacheChars ?? THREAD_CACHE_CHARS, () => this.busyThreads());
    this.defaultSelection = defaultSelection;
    this.coalesce = opts.coalesceSaves === true;
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch (error) {
      this.bots = [];
      this.botsFile = fileMissing(error) ? "missing" : "unreadable";
      if (this.botsFile === "unreadable") this.unloaded.add(BOTS_FILE);
    }
    try {
      this.groups = JSON.parse(readFileSync(GROUPS_FILE, "utf8"));
    } catch (error) {
      this.groups = [];
      this.groupsFile = fileMissing(error) ? "missing" : "unreadable";
      if (this.groupsFile === "unreadable") this.unloaded.add(GROUPS_FILE);
    }
    // busy never survives a restart - no turn does either.
    let botsMigrated = false;
    const crashedTaskThreads = new Map<string, string | null>();
    const chiefSectionsSeen = new Set<string>();
    let groupsMigrated = false;
    for (const b of this.bots) {
      // transient state never survives a restart — and if a previous
      // process died mid-turn, bots.json still says busy/working; persist
      // the reset so the next load does not read it again
      if (b.busy || (b.activity !== undefined && b.activity !== "idle")) botsMigrated = true;
      if (b.busy || (b.activity !== undefined && ACTIVITY_BUSY.has(b.activity))) {
        crashedTaskThreads.set(b.id, b.activeThreadId ?? null);
      }
      b.busy = false;
      b.activity = "idle";
      if (applyPendingModel(b)) botsMigrated = true;
      if (b.activeThreadId !== undefined) {
        delete b.activeThreadId;
        botsMigrated = true;
      }
      if (b.cloudBackend !== undefined && b.cloudBackend !== "box" && b.cloudBackend !== "vps") {
        delete b.cloudBackend;
        botsMigrated = true;
      }
      if (b.autoStartVps !== undefined && b.autoStartVps !== true && b.autoStartVps !== false) {
        delete b.autoStartVps;
        botsMigrated = true;
      }
      const avatar = botAvatarProfile(b);
      if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
        delete b.avatarUrl;
        botsMigrated = true;
      }
      if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
        delete b.avatarCrop;
        botsMigrated = true;
      }
      if (b.mascotStyle !== undefined && !botAvatarChoiceSchema.safeParse(b.mascotStyle).success) {
        delete b.mascotStyle;
        botsMigrated = true;
      }
      if (b.projectNotes !== undefined) {
        const notes = validateProjectNotes(b.projectNotes);
        if (!notes.ok || notes.path !== b.projectNotes) {
          if (notes.ok && notes.path) b.projectNotes = notes.path;
          else delete b.projectNotes;
          botsMigrated = true;
        }
      }
    }
    for (const b of this.bots) {
      if (!b.chiefOfStaff) continue;
      const key = sectionKey(b.section);
      if (!chiefSectionsSeen.has(key)) {
        chiefSectionsSeen.add(key);
        if (b.hidden) {
          b.hidden = false;
          botsMigrated = true;
        }
        continue;
      }
      b.chiefOfStaff = false;
      botsMigrated = true;
    }
    // Peer grants originally used mutable display names (ask_bot:@Helper).
    // Convert only when exactly one bot has that name; ambiguous legacy
    // entries remain inert rather than granting access to the wrong bot.
    for (const b of this.bots) {
      if (!b.alwaysAllow?.length) continue;
      let changed = false;
      const migrated = b.alwaysAllow.map((key) => {
        const match = key.match(/^(ask_bot|delegate_bot):@(.+)$/);
        if (!match) return key;
        const candidates = this.bots.filter((candidate) => candidate.name === match[2]);
        if (candidates.length !== 1) return key;
        changed = true;
        return peerAllowKey(match[1] as PeerAction, candidates[0]!.id);
      });
      if (changed) {
        b.alwaysAllow = [...new Set(migrated)];
        botsMigrated = true;
      }
    }
    for (const g of this.groups) {
      g.busyBotId = null;
      // a pin from before the cap would ride every room state push
      if (g.notice?.text && noticeText(g.notice.text) !== g.notice.text) {
        g.notice.text = noticeText(g.notice.text);
        groupsMigrated = true;
      }
      // a room saved before it had a pick answers as everyone
      const normalized = normalizeGroupDefaultResponder(g.defaultResponder ?? { kind: "everyone" }, g.memberIds, Boolean(g.dm));
      if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder)) groupsMigrated = true;
      g.defaultResponder = normalized;
      // Bot-to-bot channels intentionally remain one canonical thread.
      if (g.dm) {
        if (g.tasks !== undefined) {
          delete g.tasks;
          groupsMigrated = true;
        }
        continue;
      }
      if (!g.tasks?.length) {
        const initialTask: GroupTaskRecord = {
          threadId: g.threadId,
          title: this.firstUserLine(g.threadId) ?? UNTITLED_TASK,
          createdAt: g.createdAt,
        };
        if (g.pinnedCwd !== undefined) initialTask.pinnedCwd = g.pinnedCwd;
        if (g.pinnedMessageId) initialTask.pinnedMessageId = g.pinnedMessageId;
        g.tasks = [initialTask];
        groupsMigrated = true;
      }
      // Repair a malformed/stale active pointer conservatively. Every task
      // transcript is retained; the newest known task becomes active.
      let active = g.tasks.find((task) => task.threadId === g.threadId);
      if (!active) {
        active = g.tasks[0]!;
        g.threadId = active.threadId;
        groupsMigrated = true;
      }
      g.pinnedCwd = active.pinnedCwd;
      g.pinnedMessageId = active.pinnedMessageId;
    }
    if (botsMigrated) this.saveBots();
    if (groupsMigrated) this.saveGroups();
    // bots saved before tasks existed have one endless thread; adopt it as
    // their first task so nothing is lost and nothing special-cases it
    for (const b of this.bots) {
      if (b.tasks?.length) continue;
      b.tasks = [
        {
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        },
      ];
    }
    // Search reads SQLite directly, so migrate every known legacy transcript
    // at startup rather than waiting until the user happens to open it. Only
    // pending JSON files are touched; already-migrated threads stay lazy.
    const knownThreads = new Set([
      ...this.bots.flatMap((b) => [b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]),
      ...this.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]),
    ]);
    for (const threadId of knownThreads) {
      const legacyFile = messagesFile(threadId);
      if (existsSync(legacyFile)) mdb.readThread(threadId, legacyFile);
    }
    for (const [botId, threadId] of crashedTaskThreads) {
      const target = this.crashRecoveryTarget(botId, threadId);
      if (!target) continue;
      const existing = this.taskPacket(target.threadId);
      if (existing) {
        // a room packet names the line's first responder; Continue has to run the member that was cut off
        this.writeTaskPacket({ ...existing, botId, flushReason: "crash" });
        continue;
      }
      const instruction = lastUserInstruction(this.messagesFor(target.threadId));
      const seeded = packetAfterInterruption(null, "crash", {
        now: Date.now(),
        turnsAtWrite: target.turnsAtWrite,
      }, instruction
        ? {
          botId,
          threadId: target.threadId,
          text: instruction.text,
          messageId: instruction.messageId,
          now: instruction.at,
          turnsAtWrite: target.turnsAtWrite,
        }
        : null);
      if (seeded) this.writeTaskPacket(seeded);
    }
  }

  private saveList(file: string, json: string) {
    if (this.unloaded.has(file)) {
      setAsideFile(file);
      this.unloaded.delete(file);
    }
    writeFileAtomic(file, json, { mode: 0o600 });
  }

  saveBots() {
    this.botsSave.now();
  }

  /** Turn and send bookkeeping: one write per tick, after the reply's frames leave. A crash loses at most that tick. */
  private saveBotsSoon() {
    if (this.coalesce) this.botsSave.soon();
    else this.botsSave.now();
  }

  flushSaves() {
    this.botsSave.flush();
  }

  /** A dropped resume cursor takes its session's system text with it. */
  private pruneSessionSystems() {
    let files: string[];
    try {
      files = readdirSync(SESSION_SYSTEM_DIR);
    } catch {
      return;
    }
    // a trash list that did not load may still name sessions a restore needs
    if (this.trash.unreadable) return;
    const live = new Set<string>();
    for (const bot of [...this.bots, ...this.trash.entries.map((entry) => entry.record)]) {
      for (const cursors of [bot.resumeCursors, ...(bot.tasks ?? []).map((task) => task.resumeCursors)]) {
        for (const [instanceId, cursor] of Object.entries(cursors ?? {})) live.add(sessionSystemFile(instanceId, cursor));
      }
    }
    for (const file of files) {
      try {
        if (!live.has(file)) rmSync(join(SESSION_SYSTEM_DIR, file), { force: true });
      } catch {
        // the next save retries
      }
    }
  }

  private saveGroups() {
    this.saveList(GROUPS_FILE, JSON.stringify(this.groups.map(({ busyBotId: _busyBotId, ...g }) => g), null, 2));
  }

  setSyncWriter(writer: Store["syncWrite"]): void {
    this.syncWrite = writer;
  }

  get importingSync(): boolean {
    return this.syncImport;
  }

  applySyncImport(work: () => void): void {
    const previous = this.syncImport;
    this.syncImport = true;
    try {
      work();
    } finally {
      this.syncImport = previous;
    }
  }

  private persistThread(threadId: string, mutations: SyncMutation[], write: () => void): void {
    if (this.syncWrite) this.syncWrite(threadId, mutations, write);
    else write();
  }

  private persistTask(task: TaskRecord | GroupTaskRecord): void {
    this.persistThread(task.threadId, [{ kind: "metadata", value: { title: task.title, createdAt: task.createdAt } }], () => {});
  }

  // ── groups ────────────────────────────────────────────────────────────
  /** Subscribe to every write. Listeners run after the write and after
   * save; a throwing listener never breaks the write. */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs before a message or leaf write reaches SQLite, so a crash never leaves a durable write unannounced. */
  onBeforeWrite(listener: (threadId: string) => void): () => void {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }

  private beforeWrite(threadId: string) {
    for (const listener of [...this.writeListeners]) {
      try {
        listener(threadId);
      } catch (error) {
        console.error("store: write listener threw", error);
      }
    }
  }

  emit(change: StoreChange) {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error("store: change listener threw", error);
      }
    }
  }

  group(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  groupByThread(threadId: string): GroupRecord | undefined {
    return this.groups.find(
      (group) => group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId),
    );
  }

  createGroup(
    name: string,
    memberIds: string[],
    dm = false,
    section?: string,
    setup?: {
      bulletin?: string;
      defaultResponder?: GroupDefaultResponder;
      completed?: boolean;
    },
    hosted?: GroupRecord["hosted"],
  ): GroupRecord {
    const threadId = newId();
    const createdAt = Date.now();
    const group: GroupRecord = {
      id: newId(),
      threadId,
      name,
      memberIds,
      defaultResponder: dm
        ? { kind: "mentions" }
        : normalizeGroupDefaultResponder(setup?.defaultResponder ?? { kind: "everyone" }, memberIds, false),
      bulletin: setup?.bulletin ?? "",
      unread: false,
      createdAt,
      dm: dm || undefined,
      busyBotId: null,
      section,
      ...(hosted ? { hosted } : {}),
    };
    if (!dm) {
      group.tasks = [{ threadId, title: UNTITLED_TASK, createdAt }];
      group.setupCompletedAt = setup?.completed ? createdAt : null;
      group.setupSkippedAt = setup?.completed ? null : createdAt;
    }
    this.groups.unshift(group);
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** A room another PC made, under that PC's ids. */
  addSyncedGroup(group: GroupRecord): GroupRecord {
    group.defaultResponder = normalizeGroupDefaultResponder(group.defaultResponder, group.memberIds, Boolean(group.dm));
    this.groups.unshift(group);
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** Room thread imports write their rows outside the store. */
  syncedGroupThread(groupId: string, threadId: string): void {
    this.threads.delete(threadId);
    this.foundOnDisk.delete(threadId);
    this.saveGroups();
    this.emit({ type: "group", groupId });
  }

  /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
  dmGroup(a: string, b: string): GroupRecord | undefined {
    // the oldest, so PCs that each made one for the pair pick the same
    return this.groups.filter(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
    ).sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1))[0];
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "picture" | "notice" | "memberIds" | "defaultResponder" | "bulletin" | "unread" | "readAt" | "busyBotId" | "cwd" | "pinnedMessageId" | "section" | "pinned" | "setupCompletedAt" | "setupSkippedAt" | "hosted">>): GroupRecord | null {
    const group = this.group(id);
    if (!group) return null;
    const wasBusy = Boolean(group.busyBotId);
    if (patch.unread === false) group.readAt = Date.now();
    Object.assign(group, patch);
    if (wasBusy && !group.busyBotId) this.threads.trim();
    if (!group.dm && Object.prototype.hasOwnProperty.call(patch, "pinnedMessageId")) {
      const active = this.activeGroupTask(group.id);
      if (active) active.pinnedMessageId = patch.pinnedMessageId;
    }
    group.defaultResponder = normalizeGroupDefaultResponder(
      group.defaultResponder,
      group.memberIds,
      Boolean(group.dm),
    );
    this.saveGroups();
    if (Object.prototype.hasOwnProperty.call(patch, "memberIds")) this.repairRoomTaskPacketOwners(group);
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** A thread's durable record: DB rows plus any legacy JSON leftovers. `tell` false writes no delete for other PCs. */
  deleteThreadRecord(threadId: string, tell = true) {
    this.threads.delete(threadId);
    this.foundOnDisk.delete(threadId);
    this.taskPackets.delete(threadId);
    try {
      deleteTaskResumePacket(threadId);
    } catch {}
    if (tell) this.persistThread(threadId, [{ kind: "delete", value: { deletedAt: Date.now() } }], () => mdb.deleteThread(threadId));
    else mdb.deleteThread(threadId);
    for (const file of [messagesFile(threadId), `${messagesFile(threadId)}.imported`]) {
      try {
        unlinkSync(file);
      } catch {}
    }
    this.emit({ type: "thread.deleted", threadId });
  }

  deleteGroup(id: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    this.groups = this.groups.filter((g) => g.id !== id);
    this.saveGroups();
    for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    this.emit({ type: "group.deleted", groupId: id, ...(group.hosted ? { hosted: true as const } : {}) });
    return true;
  }

  // ── channel tasks ────────────────────────────────────────────────────
  groupTasks(groupId: string): GroupTaskRecord[] {
    const group = this.group(groupId);
    return group?.dm ? [] : (group?.tasks ?? []);
  }

  activeGroupTask(groupId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    return group?.tasks?.find((task) => task.threadId === group.threadId);
  }

  groupTaskByThread(groupId: string, threadId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    if (!group || group.dm) return undefined;
    return group.tasks?.find((task) => task.threadId === threadId);
  }

  createGroupTask(groupId: string, title?: string): GroupTaskRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm) return null;
    const task: GroupTaskRecord = {
      threadId: newId(),
      title: title?.trim().slice(0, 80) || UNTITLED_TASK,
      createdAt: Date.now(),
    };
    group.tasks = [task, ...(group.tasks ?? [])];
    group.threadId = task.threadId;
    group.pinnedCwd = undefined;
    group.pinnedMessageId = undefined;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  switchGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    const task = group?.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!group || group.dm || !task) return null;
    group.threadId = task.threadId;
    group.pinnedCwd = task.pinnedCwd;
    group.pinnedMessageId = task.pinnedMessageId;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  renameGroupTask(groupId: string, threadId: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.persistTask(task);
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  titleGroupTaskFromFirstMessage(groupId: string, text: string, threadId?: string) {
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    this.persistTask(task);
    this.saveGroups();
    this.emit({ type: "group", groupId });
  }

  deleteGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm || !group.tasks || group.tasks.length < 2) return null;
    if (!group.tasks.some((task) => task.threadId === threadId)) return null;
    group.tasks = group.tasks.filter((task) => task.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    if (group.threadId === threadId) {
      const next = group.tasks[0]!;
      group.threadId = next.threadId;
      group.pinnedCwd = next.pinnedCwd;
      group.pinnedMessageId = next.pinnedMessageId;
    }
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  /** Toggle an emoji reaction on a message ("user" or a member botId). */
  toggleReaction(threadId: string, messageId: string, emoji: string, by: string): Message | null {
    const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
    if (!existing) return null;
    const reactions = existing.reactions ?? [];
    const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
    const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
    return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
  }

  private thread(threadId: string): ThreadState {
    const cached = this.threads.get(threadId);
    if (cached) return cached;
    const { state, chars } = this.readState(threadId);
    this.threads.set(threadId, state, chars);
    this.foundOnDisk.delete(threadId);
    return state;
  }

  /** Loads a cold chat only into spare cache room, as the least recent, so a warm never evicts a chat in use. */
  warm(threadId: string): void {
    if (this.threads.has(threadId)) return;
    const { state, chars } = this.readState(threadId);
    this.threads.offer(threadId, state, chars);
    if (this.threads.has(threadId)) this.foundOnDisk.delete(threadId);
  }

  /** Takes a chat read off the server thread, unless a write loaded it first. */
  adopt(threadId: string, read: mdb.ThreadRows & { chars: number }): void {
    if (this.threads.has(threadId)) return;
    const { state, chars } = this.readState(threadId, this.coldRead(threadId, read));
    this.threads.set(threadId, state, chars);
    this.foundOnDisk.delete(threadId);
  }

  /** The active path of a chat read off the server thread, kept only in spare cache room, as warm keeps it. */
  look(threadId: string, read: mdb.ThreadRows & { chars: number }): Message[] {
    if (this.threads.has(threadId)) return this.activePath(threadId);
    const { state, chars } = this.readState(threadId, this.coldRead(threadId, read));
    const rows = walkPath(state.messages, state.activeLeafId);
    Object.freeze(rows);
    state.path = { leafId: state.activeLeafId, rows };
    if (this.threads.offer(threadId, state, chars)) this.foundOnDisk.delete(threadId);
    return rows;
  }

  // the reader picked the stored head; a find or jump from disk kept the one an earlier load held
  private coldRead(threadId: string, read: mdb.ThreadRows & { chars: number }): mdb.ThreadRows & { chars: number } {
    return this.foundOnDisk.has(threadId) ? { ...read, activeLeafId: this.diskHead(threadId) ?? read.activeLeafId } : read;
  }

  private readState(threadId: string, read = mdb.readThread(threadId, messagesFile(threadId))): { state: ThreadState; chars: number } {
    // SQLite is the source of truth; a thread with no rows imports its
    // legacy messages-<threadId>.json once, inside readThread
    const { messages, activeLeafId: storedLeaf, chars } = read;
    let activeLeafId = storedLeaf;
    // legacy rows carry no parentId — chain them in array order
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    // a find or jump from disk kept the head an earlier load fell back to, while it is still there
    const kept = this.foundOnDisk.get(threadId);
    if (!activeLeafId) activeLeafId = (kept && messages.some((m) => m.id === kept) ? kept : messages.at(-1)?.id) ?? null;
    return { state: { messages, activeLeafId }, chars };
  }

  /** Threads a running turn writes to; the cache keeps them. */
  private busyThreads(): Set<string> {
    const busy = new Set<string>();
    for (const bot of this.bots) if (bot.busy) busy.add(bot.activeThreadId ?? bot.threadId);
    for (const group of this.groups) if (group.busyBotId) busy.add(group.threadId);
    for (const threadId of this.heldThreads()) busy.add(threadId);
    return busy;
  }

  /** Driver turns survive Stop's cancel grace. Call trimThreadCache after a driver releases its thread. */
  holdThreads(held: () => Iterable<string>): void {
    this.heldThreads = held;
  }

  trimThreadCache(): void {
    this.threads.trim();
  }

  messagesFor(threadId: string): Message[] {
    // SAFETY: callers read the transcript; rows change only through the thread cache.
    return this.thread(threadId).messages as Message[];
  }

  /** One row by id: the cached copy when the thread is loaded, else a key read. */
  row(threadId: string, messageId: string): Message | undefined {
    const t = this.threads.peek(threadId);
    return t ? t.messages.find((m) => m.id === messageId) : mdb.readMessage(threadId, messageId);
  }

  activeLeaf(threadId: string): string | null {
    const head = this.threads.has(threadId) ? undefined : this.diskHead(threadId);
    return head === undefined ? this.thread(threadId).activeLeafId : head;
  }

  /** Whether the transcript is in memory; the chat list reads an unloaded one's tail instead. */
  loaded(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  /** Stable projection of replace-on-write rows from the root to the active leaf. */
  activePath(threadId: string): Message[] {
    const t = this.thread(threadId);
    if (t.path && t.path.leafId === t.activeLeafId) return t.path.rows;
    const leaf = t.messages.at(-1);
    // a row appended under the last path's leaf extends it: a 237k-row chat's walk held the server ~110 ms per send
    const path = t.path && leaf && leaf.id === t.activeLeafId && leaf.parentId && leaf.parentId === t.path.leafId
      ? [...t.path.rows, leaf]
      : walkPath(t.messages, t.activeLeafId);
    Object.freeze(path);
    t.path = { leafId: t.activeLeafId, rows: path };
    return path;
  }

  /** Which of `ids` lie on the active path; a thread not loaded walks its stored path, never reading every row. `head`, from findHead when the find began, is the head a load then would have held. */
  onActivePath(threadId: string, ids: readonly string[], head?: string | null): Set<string> {
    if (!this.threads.has(threadId)) {
      this.readOnDisk(threadId, head);
      return mdb.onStoredPath(threadId, ids, this.foundOnDisk.get(threadId));
    }
    const path = new Set(this.activePath(threadId).map((m) => m.id));
    return new Set(ids.filter((id) => path.has(id)));
  }

  /** The rows around `messageId` read from disk for a chat not loaded, which a jump once loaded; null when it is loaded or no stored row has that id. */
  storedWindow(threadId: string, messageId: string, limit: number): { messages: Message[]; hasMore: boolean } | null {
    if (this.threads.has(threadId)) return null;
    const window = mdb.storedWindow(threadId, messageId, limit);
    if (window) this.readOnDisk(threadId);
    return window;
  }

  /** For a chat not loaded, the head a load now would hold: a find reads its hits off this thread, and a sync can land before they come back. */
  findHead(threadId: string): string | null | undefined {
    return this.threads.has(threadId) ? undefined : mdb.storedHead(threadId) ?? null;
  }

  /** Notes a chat a find or jump read from disk; the first read keeps the head a load there would have held. */
  private readOnDisk(threadId: string, head = mdb.storedHead(threadId) ?? null): void {
    if (!this.foundOnDisk.has(threadId)) this.foundOnDisk.set(threadId, head);
  }

  /** The head of a chat not loaded: once a find or jump read it from disk, the head a load there held until a head is stored. */
  private diskHead(threadId: string): string | null | undefined {
    return mdb.storedHead(threadId, this.foundOnDisk.get(threadId));
  }

  /** activePath newest first, read lazily from disk when the thread is not loaded. */
  activePathBack(threadId: string): Iterable<Message> {
    return (!this.threads.has(threadId) && mdb.activePathBack(threadId, this.foundOnDisk.get(threadId))) || this.activePath(threadId).toReversed();
  }

  /** messagesFor(threadId).findLast(predicate), read newest first from disk when the thread is not loaded. */
  findLast(threadId: string, predicate: (message: Message) => boolean): Message | undefined {
    if (this.threads.has(threadId)) return this.thread(threadId).messages.findLast(predicate);
    for (const message of mdb.rowsBack(threadId)) if (predicate(message)) return message;
    return undefined;
  }

  /** activePath(threadId).findLast(predicate), walked back from disk when the thread is not loaded. */
  findLastOnPath(threadId: string, predicate: (message: Message) => boolean): Message | undefined {
    if (this.threads.has(threadId)) return this.activePath(threadId).findLast(predicate);
    for (const message of this.activePathBack(threadId)) if (predicate(message)) return message;
    return undefined;
  }

  /** activePath(threadId).slice(-count), walked back from disk when the thread is not loaded. */
  pathTail(threadId: string, count: number): Message[] {
    if (this.threads.has(threadId)) return this.activePath(threadId).slice(-count);
    const rows: Message[] = [];
    for (const message of this.activePathBack(threadId)) if (rows.unshift(message) >= count) break;
    return rows;
  }

  /** Where the rows a turn adds begin: the row count when the thread is loaded, else its newest stored rowid. */
  rowMark(threadId: string): RowMark {
    return this.threads.has(threadId) ? { count: this.thread(threadId).messages.length } : { after: mdb.lastCursor(threadId) };
  }

  /** The rows added since rowMark; a mark taken while the thread was unloaded reads them by rowid. */
  rowsSince(threadId: string, mark: RowMark): readonly Message[] {
    if ("count" in mark) return this.thread(threadId).messages.slice(mark.count);
    const rows: Message[] = [];
    for (let page = mdb.scanThreadRows(threadId, mark.after, 1024); page.messages.length; page = mdb.scanThreadRows(threadId, page.cursor, 1024)) rows.push(...page.messages);
    return rows;
  }

  /** Note rows newest first, read lazily from disk when the thread is not loaded. */
  notesBack(threadId: string): Iterable<Message> {
    return this.threads.has(threadId) ? this.thread(threadId).messages.filter((m) => m.kind === "note").toReversed() : mdb.notesBack(threadId);
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    // mail is matched by key against every row and a screen frame prunes older ones; both need the transcript
    const head = this.threads.has(threadId) || message.comm?.mailKey || message.kind === "screen" ? undefined : this.diskHead(threadId);
    if (head !== undefined) return this.appendRow(threadId, message, head);
    const t = this.thread(threadId);
    if (message.comm?.mailKey) {
      const existing = t.messages.find((row) => row.comm?.mailKey === message.comm!.mailKey);
      if (existing) {
        if (existing.comm?.peer === "reply") this.indexMail(threadId, existing);
        return existing;
      }
    }
    const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
    const previousLeaf = t.activeLeafId;
    this.threads.push(threadId, full);
    t.activeLeafId = full.id;
    this.beforeWrite(threadId);
    try {
      this.persistThread(threadId, [{ kind: "row", value: full }, { kind: "head", value: full.id }], () => mdb.appendMessage(threadId, full));
    } catch (error) {
      this.threads.pop(threadId);
      t.activeLeafId = previousLeaf;
      throw error;
    }
    if (full.comm?.mailKey && full.comm.peer === "reply") this.indexMail(threadId, full);
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(threadId, t)) {
        this.persistThread(threadId, [{ kind: "row", value: pruned }], () => mdb.updateMessage(threadId, pruned));
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.emit({ type: "message", threadId, message: full });
    // The first-run quiz is not a live ask. Talking past it hides it so the
    // transcript is just what they said. Cards with a requestId are
    // permission/question prompts and stay until answered.
    if (full.role === "user" && full.kind === "text") this.dismissOnboardingCard(threadId);
    return full;
  }

  /** appendMessage for a chat that is not loaded: writes the row and head by key and loads nothing, so a send never waits on a long chat's read. */
  private appendRow(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }, head: string | null): Message {
    const full: Message = { id: newId(), at: Date.now(), parentId: head, ...redactBotAuthored(message) };
    this.beforeWrite(threadId);
    this.persistThread(threadId, [{ kind: "row", value: full }, { kind: "head", value: full.id }], () => mdb.appendMessage(threadId, full));
    this.emit({ type: "message", threadId, message: full });
    if (full.role === "user" && full.kind === "text") this.dismissOnboardingCard(threadId);
    return full;
  }

  appendCompaction(threadId: string, compaction: ContextCompactionV1): Message {
    const checked = readContextCompaction({
      value: {
        ...compaction,
        summary: redactSecretsInText(compaction.summary),
      },
    });
    if (checked.status !== "valid") throw new Error("invalid context compaction state");
    return this.appendMessage(threadId, {
      role: "bot",
      kind: "compaction",
      compaction: checked.value,
    });
  }

  /** Hide the first-run quiz on this thread, if it is still open. */
  dismissOnboardingCard(threadId: string): Message | null {
    const rows = this.threads.has(threadId) ? this.thread(threadId).messages : mdb.optionRows(threadId);
    const card = rows.find(
      (message) =>
        message.kind === "options" && message.card && !message.card.requestId && !message.card.askUser && !message.card.dismissed,
    );
    if (!card?.card) return null;
    return this.patchRow(threadId, card.id, { card: { ...card.card, dismissed: true } });
  }

  recordCardAnswer(threadId: string, messageId: string, text: string): Message | null {
    const card = this.thread(threadId).messages.find((message) => message.id === messageId)?.card;
    if (!card) return null;
    return this.patchMessage(threadId, messageId, { card: { ...card, answerText: text } });
  }

  /** Screen frames are ~100-500KB of base64 each; keeping every frame of a
   * long computer session bloats the transcript for nothing the client
   * would ever show. The newest few keep their pixels; older ones stay in
   * the transcript as placeholders. Mirrors the client's own frame cap.
   * Returns the messages whose pixels were dropped so the caller can
   * persist exactly those. */
  private pruneScreenFrames(threadId: string, t: ThreadState, keep = 4): Message[] {
    const pruned: Message[] = [];
    let seen = 0;
    for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
      const m = t.messages[i];
      if (m.kind !== "screen" || !m.png || m.shown) continue;
      seen += 1;
      if (seen > keep) {
        const shed = { ...m, png: undefined };
        this.threads.put(threadId, i, shed);
        pruned.push(shed);
      }
    }
    return pruned;
  }

  /** Fork the conversation: a new user message that replaces `sourceId`
   * (same parent, new text) and becomes the active leaf. */
  branchMessage(threadId: string, sourceId: string, text: string): Message | null {
    const t = this.thread(threadId);
    const source = t.messages.find((m) => m.id === sourceId);
    if (!source) return null;
    const full: Message = {
      id: newId(),
      at: Date.now(),
      role: "user",
      kind: "text",
      text,
      parentId: source.parentId ?? null,
      replyToId: source.replyToId,
    };
    this.threads.push(threadId, full);
    t.activeLeafId = full.id;
    this.beforeWrite(threadId);
    this.persistThread(threadId, [{ kind: "row", value: full }, { kind: "head", value: full.id }], () => mdb.appendMessage(threadId, full));
    this.emit({ type: "message", threadId, message: full });
    return full;
  }

  /** Point the visible conversation at the branch containing `messageId`,
   * descending to that branch's most recently active leaf. */
  setActiveLeaf(threadId: string, messageId: string): string | null {
    const t = this.thread(threadId);
    if (!t.messages.some((m) => m.id === messageId)) return null;
    let cur = messageId;
    for (;;) {
      const children = t.messages.filter((m) => m.parentId === cur);
      if (!children.length) break;
      cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
    }
    t.activeLeafId = cur;
    this.beforeWrite(threadId);
    this.persistThread(threadId, [{ kind: "head", value: cur }], () => mdb.setActiveLeaf(threadId, cur));
    this.emit({ type: "thread", threadId, activeLeafId: cur });
    return cur;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const t = this.thread(threadId);
    const idx = t.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    // Same scrub as appendMessage: a patch is a durable write too, and the
    // hydrate that GET /api/bots serves reads the patched record, not the
    // frame the UI already saw.
    this.threads.put(threadId, idx, redactBotAuthored({ ...t.messages[idx]!, ...patch, card: patch.card ?? t.messages[idx]!.card }));
    this.beforeWrite(threadId);
    this.persistThread(threadId, [{ kind: "row", value: t.messages[idx] }], () => mdb.updateMessage(threadId, t.messages[idx]));
    if (t.messages[idx].comm?.mailKey && t.messages[idx].comm?.peer === "reply") this.indexMail(threadId, t.messages[idx]);
    this.emit({ type: "message.patch", threadId, message: t.messages[idx] });
    return t.messages[idx];
  }

  /** patchMessage for a thread that may not be loaded: reads and writes the one row by key and loads nothing. */
  patchRow(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    if (this.threads.has(threadId)) return this.patchMessage(threadId, messageId, patch);
    const row = mdb.readMessage(threadId, messageId);
    if (!row) return null;
    const next = redactBotAuthored({ ...row, ...patch, card: patch.card ?? row.card });
    this.beforeWrite(threadId);
    this.persistThread(threadId, [{ kind: "row", value: next }], () => mdb.updateMessage(threadId, next));
    if (next.comm?.mailKey && next.comm?.peer === "reply") this.indexMail(threadId, next);
    this.emit({ type: "message.patch", threadId, message: next });
    return next;
  }

  private indexMail(threadId: string, row: Message): void {
    const bot = this.botByThread(threadId);
    const task = bot && this.taskByThread(bot.id, threadId);
    if (task && indexMailRow(task, row)) this.saveBots();
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId || b.tasks?.some((t) => t.threadId === threadId)) ?? null;
  }

  conversationForBot(botId: string, threadId: string) {
    const bot = this.bot(botId);
    if (!bot) return null;
    if (this.taskByThread(botId, threadId)) return { bot, group: undefined };
    const group = this.groupByThread(threadId);
    return group?.memberIds.includes(botId) ? { bot, group } : null;
  }

  createBot(
    profile: Partial<
      Pick<BotRecord, "name" | "title" | "description" | "color" | "mascotExpression" | "mascotStyle" | "modelSelection" | "section" | "computer" | "cwd" | "autoApprove">
    > = {},
    opts: {
      /** @deprecated no-op: a new bot's chat starts empty. */
      seedMessages?: boolean;
      job?: string;
      /** Test seam for the packaged-Windows first-run computer default. */
      host?: { platform?: string; packaged?: boolean };
      /** A bot lost with bots.json comes back under its old id. */
      id?: string;
    } = {},
  ): BotRecord {
    const name = profile.name?.trim() || pickBotName(this.bots.map((b) => b.name));
    const job = opts.job?.trim();
    const section = sectionKey(profile.section);
    const computer = profile.computer ?? defaultComputerForNewBot(opts.host);
    const bot: BotRecord = {
      id: opts.id ?? newId(),
      threadId: newId(),
      name,
      title: profile.title ?? (job ? titleFromMessage(job) : ""),
      description: profile.description ?? job ?? "",
      notifications: true,
      color: profile.color ?? "white",
      mascotStyle: profile.mascotStyle ?? nextWinkAvatar(this.bots),
      ...(profile.mascotExpression ? { mascotExpression: profile.mascotExpression } : {}),
      unread: false,
      modelSelection: profile.modelSelection ?? this.defaultSelection(),
      resumeCursors: {},
      createdAt: Math.max(Date.now(), ...this.bots.map((b) => (b.createdAt ?? 0) + 1)),
      ...(computer ? { computer } : {}),
    };
    if (profile.cwd) bot.cwd = profile.cwd;
    if (profile.autoApprove) bot.autoApprove = true;
    if (section) bot.section = section;
    bot.tasks = [{ threadId: bot.threadId, title: UNTITLED_TASK, createdAt: bot.createdAt, resumeCursors: {} }];
    this.bots.unshift(bot);
    this.persistTask(bot.tasks[0]);
    this.saveBots();
    this.emit({ type: "bot", botId: bot.id });
    return bot;
  }

  /** Takes `id` out of every room it can leave. */
  leaveRooms(id: string): void {
    for (const group of this.groups) {
      const patch: Partial<Pick<GroupRecord, "memberIds" | "busyBotId">> = {};
      if (group.busyBotId === id) patch.busyBotId = null;
      if (group.memberIds.includes(id)) {
        // a member edit can't change a DM's pair or empty a room, so those keep the id
        if (!group.dm && group.memberIds.length > 1) patch.memberIds = group.memberIds.filter((memberId) => memberId !== id);
        else this.repairRoomTaskPacketOwners(group);
      }
      if (Object.keys(patch).length) this.patchGroup(group.id, patch);
    }
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    this.leaveRooms(id);
    // every task's transcript goes with the bot, not just the open one
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    // the bot's workspace (files + memory) goes with it — same rule as its
    // transcripts: deleting a bot deletes what it knew
    try {
      removeWorkspace(id);
    } catch {}
    this.saveBots();
    this.emit({ type: "bot.deleted", botId: id });
    return true;
  }

  /** False unless `ids` names every bot exactly once. */
  reorderBots(ids: string[]): boolean {
    const byId = new Map(this.bots.map((bot) => [bot.id, bot]));
    if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
      return false;
    }
    this.bots = ids.map((id) => byId.get(id)!);
    this.saveBots();
    this.emit({ type: "bots.order", botIds: ids });
    return true;
  }

  /** False unless `ids` names every group exactly once. */
  reorderGroups(ids: string[]): boolean {
    const byId = new Map(this.groups.map((group) => [group.id, group]));
    if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
      return false;
    }
    this.groups = ids.map((id) => byId.get(id)!);
    this.saveGroups();
    this.emit({ type: "groups.order", groupIds: ids });
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>, opts: { soon?: boolean } = {}): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    // Settings Clear is cwd: null. Drop the remembered auto-folder too or
    // the next unpinned task still lands there. Negation uses
    // forgetProjectCwd and leaves an explicit pin alone. The stamp keeps
    // earlier chat lines from re-remembering the folder on a later turn.
    const clearingCwd = Object.prototype.hasOwnProperty.call(patch, "cwd") && patch.cwd == null;
    if (patch.unread === false) bot.readAt = Date.now();
    Object.assign(bot, patch);
    if (clearingCwd) {
      delete bot.cwd;
      delete bot.lastProjectCwd;
      bot.projectFolderClearedAt = Date.now();
    }
    if (opts.soon) this.saveBotsSoon();
    else this.saveBots();
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  /** The one way runtime state changes. Sets `activity` and derives `busy`
   * from it, so a reader that only knows busy sees the same truth. */
  setActivity(botId: string, activity: BotActivity, activeThreadId?: ThreadId): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const previousThreadId = bot.busy ? bot.activeThreadId ?? bot.threadId : undefined;
    const busy = ACTIVITY_BUSY.has(activity);
    const nextThreadId = busy ? activeThreadId ?? bot.activeThreadId : undefined;
    const settled = !busy && bot.pendingModelSelection !== undefined;
    if (
      !settled &&
      bot.activity === activity &&
      Boolean(bot.busy) === busy &&
      bot.activeThreadId === nextThreadId
    ) return bot;
    bot.activity = activity;
    bot.busy = busy;
    // Every next turn checks busy before it reads modelSelection.
    applyPendingModel(bot);
    if (nextThreadId) bot.activeThreadId = nextThreadId;
    else delete bot.activeThreadId;
    if (previousThreadId && (!busy || previousThreadId !== (nextThreadId ?? bot.threadId))) this.threads.trim();
    this.saveBotsSoon();
    this.emit({ type: "bot", botId });
    return bot;
  }

  /** Elect one Chief of Staff in its section (or clear one section) as one persisted change.
   * The changed records are returned so the server can update every open
   * window, including the bot that just handed the role over. */
  setChiefOfStaff(id: string | null, section?: string | null): BotRecord[] | null {
    const selected = id ? this.bot(id) : null;
    if (id && !selected) return null;
    const targetSection = sectionKey(selected?.section ?? section);
    const changed: BotRecord[] = [];
    for (const bot of this.bots) {
      if (sectionKey(bot.section) !== targetSection) continue;
      const next = bot.id === id;
      if (Boolean(bot.chiefOfStaff) === next && !(next && bot.hidden)) continue;
      if (next) {
        bot.chiefOfStaff = true;
        // A section's main contact must stay reachable in the sidebar.
        bot.hidden = false;
      } else {
        bot.chiefOfStaff = false;
      }
      changed.push(bot);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string) {
    const bot = this.bot(botId);
    if (!bot) return;
    // the cursor belongs to the task that produced it, not to the bot
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (task) task.resumeCursors[instanceId] = cursor;
    // The legacy mirror follows the task visible in chat, never a detached
    // routine task working in the background.
    if (!threadId || bot.threadId === threadId) bot.resumeCursors[instanceId] = cursor;
    this.saveBotsSoon();
    this.emit({ type: "bot", botId });
  }

  clearAccountSessions(instanceId: string) {
    const changed = clearAccountSessions(this.bots, instanceId);
    if (changed.length) this.saveBots();
    for (const botId of changed) this.emit({ type: "bot", botId });
  }

  /** The system text a resumed session holds: what it started with, plus
   * every change a reminder already brought it. Undefined when unknown. */
  sessionSystem(instanceId: string, cursor: ResumeSeed["cursor"]): string | undefined {
    return readSessionSystem(instanceId, cursor);
  }

  recordSessionSystem(instanceId: string, cursor: ResumeSeed["cursor"], text: string) {
    if (cursor === undefined || this.sessionSystem(instanceId, cursor) === text) return;
    writeSessionSystem(instanceId, cursor, text);
  }

  /** Mark the user send that recycled the provider session so later
   * turns count only tools that landed in the new native session. Also
   * drops `lastInput` — that number described the session we just threw
   * away. */
  markProviderSessionBound(botId: string, threadId: string, messageId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || !messageId) return;
    const lastInput = task.usage?.lastInput;
    if (task.providerSessionBoundId === messageId && lastInput === undefined) return;
    task.providerSessionBoundId = messageId;
    if (task.usage && lastInput !== undefined) {
      const next = { ...task.usage };
      delete next.lastInput;
      task.usage = next;
    }
    this.saveBotsSoon();
    this.emit({ type: "bot", botId });
  }

  /** Drop provider-native session ids for this task so the next turn
   * injects Orbit's prepared transcript instead of `--resume`ing a fat
   * CLI session. Other tasks on the same bot keep their cursors. */
  clearResumeCursors(botId: string, threadId?: string) {
    const bot = this.bot(botId);
    if (!bot) return;
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    const mirrorsBot = !threadId || bot.threadId === threadId;
    const taskEmpty = !task || Object.keys(task.resumeCursors).length === 0;
    const botEmpty = !mirrorsBot || Object.keys(bot.resumeCursors).length === 0;
    if (taskEmpty && botEmpty) return;
    if (task) {
      task.resumeCursors = {};
      delete task.resumeSeed;
    }
    if (mirrorsBot) bot.resumeCursors = {};
    this.saveBotsSoon();
    this.emit({ type: "bot", botId });
  }

  /** A bot's working folder changed: unpin every task's folder and drop
   * the resume state that would resurrect an old-rooted CLI session on
   * that thread. CLI sessions persist their creation root, so re-pinning
   * without recycling would lie (Orbit says the new root, the CLI works
   * in the old one). The next turn re-pins from the new bot.cwd (the pin
   * wins in resolveProjectFolder) on a FRESH session. Scoped strictly to
   * this bot's threads — rooms keep their own rules, other bots untouched.
   * The caller compares old vs new first; same value never reaches here. */
  resetTasksForCwdChange(botId: string): void {
    const bot = this.bot(botId);
    if (!bot) return;
    let touched = false;
    for (const task of bot.tasks ?? []) {
      if (task.cwd !== undefined) {
        task.cwd = undefined;
        touched = true;
      }
      if (Object.keys(task.resumeCursors).length !== 0) {
        task.resumeCursors = {};
        touched = true;
      }
      if (task.resumeSeed !== undefined) {
        delete task.resumeSeed;
        touched = true;
      }
    }
    if (Object.keys(bot.resumeCursors).length !== 0) {
      bot.resumeCursors = {};
      touched = true;
    }
    if (!touched) return;
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  markResumeSeeded(botId: string, threadId: string, seed: ResumeSeed) {
    const task = this.taskByThread(botId, threadId);
    if (!task) return;
    const current = task.resumeSeed;
    if (current && current.instanceId === seed.instanceId && current.cursor === seed.cursor && current.compactionId === seed.compactionId) return;
    task.resumeSeed = { ...seed };
    this.saveBotsSoon();
  }

  /** Keep a settled turn's prompt sizes under the session it ran on. A cursor
   * the record does not name is a new session, so its first report is where
   * that session started. The window belongs to the model, not the session. */
  recordNativePrompt(
    botId: string,
    threadId: string,
    instanceId: string,
    prompt: { first: number; last: number },
    contextWindow?: number,
  ) {
    const task = this.taskByThread(botId, threadId);
    const cursor = task?.resumeCursors[instanceId];
    if (!task || cursor === undefined) return undefined;
    const same = task.nativePrompt?.cursor === cursor ? task.nativePrompt : undefined;
    const window = contextWindow && task.lastModel ? { model: task.lastModel, tokens: contextWindow } : task.nativePrompt?.window;
    task.nativePrompt = { cursor, first: same?.first ?? prompt.first, last: prompt.last, growth: prompt.last - (same?.last ?? prompt.first), window };
    this.saveBotsSoon();
    return task.nativePrompt;
  }

  /** Repoint saved bot selections and task continuity from a retired model id. */
  renameModel(instanceIds: string[], from: string, to: string, options: { resetSession?: boolean } = {}) {
    let changed = false;
    for (const b of this.bots) {
      if (!b.modelSelection || !instanceIds.includes(b.modelSelection.instanceId) || b.modelSelection.model !== from) continue;
      b.modelSelection.model = to;
      changed = true;
    }
    for (const task of this.bots.flatMap((b) => b.tasks ?? [])) {
      if (task.lastInstanceId === undefined || !instanceIds.includes(task.lastInstanceId) || task.lastModel !== from) continue;
      task.lastModel = to;
      changed = true;
      if (options.resetSession) {
        const cursor = task.resumeCursors[task.lastInstanceId];
        delete task.resumeCursors[task.lastInstanceId];
        if (task.resumeSeed?.instanceId === task.lastInstanceId && (cursor === undefined || task.resumeSeed.cursor === cursor)) delete task.resumeSeed;
        delete task.nativePrompt;
        const bot = this.bots.find((candidate) => candidate.tasks?.includes(task));
        if (bot?.threadId === task.threadId) delete bot.resumeCursors[task.lastInstanceId];
        delete task.providerSessionBoundId;
      }
    }
    if (changed) this.saveBots();
  }

  markPaneNotesDelivered(botId: string, threadId: string, noteId: string | undefined) {
    const task = this.taskByThread(botId, threadId);
    const next = noteId ?? task?.paneNotesDeliveredId ?? null;
    if (!task || task.paneNotesDeliveredId === next) return;
    task.paneNotesDeliveredId = next;
    this.saveBotsSoon();
  }

  markReactionsDelivered(botId: string, threadId: string, keys: string[]) {
    const task = this.taskByThread(botId, threadId);
    const same = task?.reactionsDelivered?.length === keys.length && keys.every((key, i) => task.reactionsDelivered?.[i] === key);
    if (!task || same) return;
    task.reactionsDelivered = keys;
    this.saveBotsSoon();
  }

  /** Marks a steer carried, added once the model took it in; keeps what a later dispatch recorded. */
  addReactionsDelivered(botId: string, threadId: string, keys: string[]) {
    if (!keys.length) return;
    const delivered = this.taskByThread(botId, threadId)?.reactionsDelivered ?? [];
    this.markReactionsDelivered(botId, threadId, [...new Set([...delivered, ...keys])]);
  }

  markPaneNotesSkipped(botId: string, threadId: string, noteId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.paneNotesSkippedId === noteId) return;
    task.paneNotesSkippedId = noteId;
    this.saveBots();
  }

  /** Record which instance just took a turn on this task. Called at
   * dispatch, not at cursor time — transcript-replay engines never
   * produce a cursor, and they still count as having run last. */
  markTaskDispatched(botId: string, threadId: string, instanceId: string, model: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || (task.lastInstanceId === instanceId && task.lastModel === model)) return;
    task.lastInstanceId = instanceId;
    task.lastModel = model;
    this.saveBotsSoon();
  }

  /** Bank one settled turn onto its task. Called once per turn.completed;
   * the running per-driver token indicator is deliberately not used here
   * because its meaning differs by driver. */
  addTaskUsage(
    botId: string,
    threadId: string,
    turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null },
  ): TaskUsage | null {
    const task = this.taskByThread(botId, threadId);
    if (!task) return null;
    const prev: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, ...task.usage };
    const cost = typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) ? turn.costUsd : null;
    const prevCost = typeof prev.costUsd === "number" ? prev.costUsd : null;
    // providers occasionally report NaN or a negative on a partial turn —
    // never let that poison a running tally
    const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    // the cached share exists on a record only once a driver has reported
    // it — a driver that never does leaves the record shaped as before
    const cachedKnown = typeof prev.cachedInput === "number" || typeof turn.cachedInput === "number";
    const prevInput = clean(prev.input);
    const turnInput = clean(turn.input);
    const nextCachedInput = Math.min(clean(prev.cachedInput), prevInput)
      + Math.min(clean(turn.cachedInput), turnInput);
    const lastInput = turnInput > 0 ? turnInput : prev.lastInput;
    task.usage = {
      input: prevInput + turnInput,
      output: prev.output + clean(turn.output),
      ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
      ...(lastInput !== undefined ? { lastInput } : {}),
      costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
      turns: prev.turns + 1,
    };
    this.saveBotsSoon();
    this.emit({ type: "bot", botId });
    return task.usage;
  }

  /** The folder a task's turn runs in. Pins on first call from the bot's
   * current folder — unless the task already has a session (a thread from
   * before folders existed), which pins to the default so the folder can't
   * move under it. Returns the pinned value: a path, or null for default. */
  pinTaskCwd(botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean } = {}): string | null {
    const bot = this.bot(botId);
    const task = bot ? this.taskByThread(botId, threadId) : undefined;
    if (!bot || !task) return null;
    if (opts.none) {
      if (task.cwd !== null) {
        task.cwd = null;
        this.saveBotsSoon();
        this.emit({ type: "bot", botId });
      }
      return null;
    }
    if (task.cwd === undefined) {
      task.cwd = Object.keys(task.resumeCursors).length === 0 ? (bot.cwd ?? fallbackCwd ?? null) : null;
      this.saveBotsSoon();
      this.emit({ type: "bot", botId });
    }
    return task.cwd;
  }

  /** Remember the project this bot last resolved from chat. Does not set
   * `cwd` (that remains the explicit pin) and does not remount this task.
   * Clients see it as `rememberedProjectCwd` — next-task only. */
  rememberProjectCwd(botId: string, cwd: string): void {
    const bot = this.bot(botId);
    if (!bot || !cwd || bot.lastProjectCwd === cwd) return;
    bot.lastProjectCwd = cwd;
    this.saveBotsSoon();
  }

  rememberRepos(botId: string, repos: string[]): void {
    const bot = this.bot(botId);
    if (!bot) return;
    bot.knownRepos = repos;
    this.saveBotsSoon();
  }

  /** Drop a remembered project so a ruled-out folder does not stick. */
  forgetProjectCwd(botId: string): void {
    const bot = this.bot(botId);
    if (!bot?.lastProjectCwd) return;
    delete bot.lastProjectCwd;
    this.saveBotsSoon();
  }

  /** The folder a room's member turns run in. Pins on the first turn that
   * dispatches, from the room's `cwd` at that moment. Pinned, not read
   * live, for the same reason tasks pin (see pinTaskCwd): engines key
   * their sessions and files to the folder a thread starts in, and a room
   * lives on ONE thread forever — so changing the room's folder applies to
   * future rooms, never under a room that already started working
   * somewhere. Returns the pinned value: a path, or null = each member's
   * own default. */
  pinGroupCwd(groupId: string, threadId?: string): string | null {
    const group = this.group(groupId);
    if (!group) return null;
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    // Direct-message channels retain the original single-thread contract.
    if (!task) {
      if (!group.dm) return null;
      if (group.pinnedCwd === undefined) {
        group.pinnedCwd = group.cwd ?? null;
        this.saveGroups();
        this.emit({ type: "group", groupId: group.id });
      }
      return group.pinnedCwd;
    }
    if (task.pinnedCwd === undefined) {
      task.pinnedCwd = group.cwd ?? null;
      if (group.threadId === task.threadId) group.pinnedCwd = task.pinnedCwd;
      this.saveGroups();
      this.emit({ type: "group", groupId: group.id });
    }
    return task.pinnedCwd;
  }

  // ── tasks ─────────────────────────────────────────────────────────────
  /** The first thing the human asked in a thread — a task's natural name. */
  private firstUserLine(threadId: string): string | null {
    const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
    return first?.text ? titleFromMessage(first.text) : null;
  }

  tasks(botId: string): TaskRecord[] {
    return this.bot(botId)?.tasks ?? [];
  }

  activeTask(botId: string): TaskRecord | undefined {
    const bot = this.bot(botId);
    return bot?.tasks?.find((t) => t.threadId === bot.threadId);
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
  }

  /** Resolve the thread that was in flight when this process died. 1:1 tasks
   * stay on the bot record; room turns live on the channel thread. */
  private crashRecoveryTarget(botId: string, threadId: string | null): { threadId: string; turnsAtWrite: number } | null {
    if (threadId) {
      const task = this.taskByThread(botId, threadId);
      if (task) return { threadId: task.threadId, turnsAtWrite: task.usage?.turns ?? 0 };
      if (this.conversationForBot(botId, threadId)) {
        return { threadId, turnsAtWrite: this.taskPacket(threadId)?.turnsAtWrite ?? 0 };
      }
      return null;
    }
    const task = this.activeTask(botId);
    return task ? { threadId: task.threadId, turnsAtWrite: task.usage?.turns ?? 0 } : null;
  }

  private repairRoomTaskPacketOwner(group: GroupRecord, threadId: string): TaskResumePacket | null {
    if (!this.taskPackets.has(threadId)) this.taskPackets.set(threadId, readTaskResumePacket(threadId));
    const packet = this.taskPackets.get(threadId);
    if (!packet) return null;
    if (group.memberIds.includes(packet.botId) && this.bot(packet.botId)) return packet;
    const botId = group.memberIds.find((memberId) => Boolean(this.bot(memberId)));
    if (!botId) {
      this.taskPackets.set(threadId, null);
      try {
        deleteTaskResumePacket(threadId);
      } catch {}
      this.emit({ type: "task.packet", threadId });
      return null;
    }
    let saved: TaskResumePacket;
    try {
      saved = this.savePacket({ ...packet, botId });
    } catch {
      return null;
    }
    this.emit({ type: "task.packet", threadId });
    return saved;
  }

  private repairRoomTaskPacketOwners(group: GroupRecord): void {
    if (group.dm) return;
    for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
      this.repairRoomTaskPacketOwner(group, threadId);
    }
  }

  taskPacket(threadId: string): TaskResumePacket | null {
    if (!this.taskPackets.has(threadId)) {
      // an unknown thread may be a trashed bot's, so its null is not cached past a restore
      if (!this.botByThread(threadId) && !this.groupByThread(threadId)) return null;
      this.taskPackets.set(threadId, readTaskResumePacket(threadId));
    }
    const packet = this.taskPackets.get(threadId);
    if (!packet) return null;
    if (this.conversationForBot(packet.botId, threadId)) return structuredClone(packet);
    const group = this.groupByThread(threadId);
    const repaired = group && !group.dm ? this.repairRoomTaskPacketOwner(group, threadId) : null;
    return repaired ? structuredClone(repaired) : null;
  }

  /** Open asks the bot's other owner chats hold, newest copy of each, minus the ones this chat already has; none for or from a room or routine thread in notOwner. */
  otherChatAsks(botId: string, threadId: string, notOwner: ReadonlySet<string>): TaskAsk[] {
    const bot = this.bot(botId);
    if (!bot || notOwner.has(threadId)) return [];
    const key = (ask: TaskAsk) => `${ask.at}\0${ask.ask}`;
    const own = new Set((this.taskPacket(threadId)?.asks ?? []).map(key));
    const threads = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
    threads.delete(threadId);
    const records = [...threads].filter((id) => !notOwner.has(id)).map((id) => this.taskPacket(id)).filter((record) => record !== null);
    return latestTaskAsks(records, (ask) => ask.ask).filter((ask) => isOpenAsk(ask) && !own.has(key(ask)));
  }

  /** `staged` is a send's write: readers have the record at once, and settleTaskPacket pays its fsync after the dispatch. `seen` holds the asks of queued records this one replaced and the closed asks its update trimmed. */
  writeTaskPacket(packet: TaskResumePacket, opts: { staged?: boolean } = {}, seen: readonly TaskAsk[] = []): TaskResumePacket | null {
    if (!this.conversationForBot(packet.botId, packet.threadId)) return null;
    const saved = this.savePacket(packet, opts, seen);
    this.emit({ type: "task.packet", threadId: packet.threadId });
    return structuredClone(saved);
  }

  // every packet write comes through here, so an ask a write drops is logged, never lost silently
  private savePacket(packet: TaskResumePacket, opts: { staged?: boolean; settle?: boolean } = {}, seen: readonly TaskAsk[] = []): TaskResumePacket {
    const before = this.taskPackets.has(packet.threadId) ? this.taskPackets.get(packet.threadId) : readTaskResumePacket(packet.threadId);
    const saved = opts.settle ? settleTaskResumePacket(packet.threadId) ?? packet : opts.staged ? stageTaskResumePacket(packet) : writeTaskResumePacket(packet);
    this.taskPackets.set(packet.threadId, saved);
    logDroppedAsks(saved, before?.asks, seen, packet.asks);
    return saved;
  }

  settleTaskPacket(threadId: string): void {
    const staged = this.taskPackets.get(threadId);
    try {
      if (staged) this.savePacket(staged, { settle: true });
    } catch (error) {
      console.error("task state: settle failed", error);
    }
  }

  /** A fresh context on the same bot: new thread, new session, same
   * persona/tools/computer. Becomes the active task. */
  createTask(botId: string, title?: string, activate = true): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const task: TaskRecord = {
      threadId: newId(),
      title: title?.trim() || UNTITLED_TASK,
      createdAt: Date.now(),
      resumeCursors: {},
    };
    bot.tasks = [task, ...(bot.tasks ?? [])];
    if (activate) {
      bot.threadId = task.threadId;
      bot.resumeCursors = {}; // legacy mirror follows the active task
    }
    this.persistTask(task);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Take a task's transcript from another device. Provider sessions are
   * per device, so the next turn replays the transcript instead. `follow`
   * makes it the active task when it is newer or the active one is empty, which
   * is then dropped; the caller vouches no turn is starting. */
  adoptSyncedTask(
    botId: string,
    task: Pick<TaskRecord, "threadId" | "title" | "createdAt">,
    messages: Message[],
    activeLeafId: string | null,
    follow = false,
  ): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const { threadId } = task;
    const newest = (list: Message[], floor: number) => list.reduce((max, m) => Math.max(max, m.at), floor);
    const current = bot.threadId;
    const empty = this.messagesFor(current).length === 0;
    const followed = follow && !bot.busy && current !== threadId
      && (empty || newest(messages, -Infinity) > newest(this.messagesFor(current), this.activeTask(botId)?.createdAt ?? 0));
    const t = this.thread(threadId);
    const receipts = new Map(t.messages.filter(message => message.mailbox).map(message => [message.id, message.mailbox]));
    messages = messages.map(message => receipts.has(message.id) ? { ...message, mailbox: receipts.get(message.id) } : message);
    const before = new Map(t.messages.map((m) => [m.id, JSON.stringify(m)]));
    mdb.replaceThread(threadId, messages, activeLeafId);
    this.threads.reset(threadId, messages);
    t.activeLeafId = activeLeafId ?? messages.at(-1)?.id ?? null;
    let record = this.taskByThread(botId, threadId);
    if (record) {
      record.title = task.title;
      record.resumeCursors = {};
      delete record.lastInstanceId;
      delete record.providerSessionBoundId;
      delete record.resumeSeed;
    } else {
      record = { threadId, title: task.title, createdAt: task.createdAt, resumeCursors: {} };
      const tasks = bot.tasks ?? [];
      const at = tasks.findIndex((candidate) => candidate.createdAt < task.createdAt);
      tasks.splice(at < 0 ? tasks.length : at, 0, record);
      bot.tasks = tasks;
    }
    rebuildMailIndex(record, messages);
    if (followed) bot.threadId = threadId;
    if (bot.threadId === threadId) bot.resumeCursors = {};
    if (followed && empty) {
      bot.tasks = bot.tasks!.filter((candidate) => candidate.threadId !== current);
      this.deleteThreadRecord(current);
    }
    this.saveBots();
    for (const message of messages) {
      const prior = before.get(message.id);
      if (prior === undefined) this.emit({ type: "message", threadId, message, imported: true });
      else if (prior !== JSON.stringify(message)) this.emit({ type: "message.patch", threadId, message });
    }
    if (t.activeLeafId) this.emit({ type: "thread", threadId, activeLeafId: t.activeLeafId });
    this.emit(followed ? { type: "bot", botId, switched: true } : { type: "bot", botId });
    return record;
  }

  removeSyncNotices(threadId: string, ids: string[]): void {
    const moved = new Map<string, Message>();
    let leaf: string | null | undefined;
    mdb.withMessageTransaction((db) => {
      for (const id of ids) {
        const row = db.prepare("SELECT json FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id);
        if (!row) continue;
        const message: Message = JSON.parse(String(row.json));
        const parent = message.parentId ?? null;
        // SAFETY: json is the stored Message.
        for (const child of db.prepare("SELECT json FROM messages WHERE thread_id = ? AND json_extract(json, '$.parentId') = ?").all(threadId, id) as Array<{ json: string }>) {
          const next: Message = { ...JSON.parse(child.json), parentId: parent };
          moved.set(next.id, next);
        }
        db.prepare("UPDATE messages SET json = json_set(json, '$.parentId', ?) WHERE thread_id = ? AND json_extract(json, '$.parentId') = ?")
          .run(parent, threadId, id);
        if (db.prepare("UPDATE thread_state SET active_leaf_id = ? WHERE thread_id = ? AND active_leaf_id = ?").run(parent, threadId, id).changes) leaf = parent;
        db.prepare("DELETE FROM messages WHERE thread_id = ? AND id = ?").run(threadId, id);
        moved.delete(id);
      }
    });
    this.threads.delete(threadId);
    this.foundOnDisk.delete(threadId);
    // a client that already painted this chat follows the new parents and leaf
    for (const message of moved.values()) this.emit({ type: "message.patch", threadId, message });
    if (leaf) this.emit({ type: "thread", threadId, activeLeafId: leaf });
  }

  applySyncChanges(botId: string, threadId: string, changes: SyncChange[]): void {
    const bot = this.bot(botId);
    if (!bot || !changes.length) return;
    this.applySyncImport(() => {
      if (changes.some((change) => change.kind === "delete")) {
        this.removeSyncedTask(botId, threadId);
        return;
      }
      let task = this.taskByThread(botId, threadId);
      if (!task) {
        task = { threadId, title: UNTITLED_TASK, createdAt: 0, resumeCursors: {} };
        bot.tasks = [...(bot.tasks ?? []), task];
      }
      // a parentless row or a null head reads differently from disk than in a loaded chat; read in a chat find left on disk first, as finding it once loaded it
      const loadedReading = (change: SyncChange) => change.kind === "head" ? change.value === null : change.kind === "row" && (change.value as Message).parentId === undefined;
      if (this.foundOnDisk.has(threadId) && changes.some(loadedReading)) this.thread(threadId);
      const cached = this.threads.peek(threadId);
      const events: StoreChange[] = [];
      const pathChanged = mdb.withMessageTransaction((db) => {
        const changed = syncPathChanged(db, threadId, changes);
        for (const change of changes) {
          if (change.kind === "metadata") {
            // SAFETY: The sync engine validates metadata before adding a change page.
            const metadata = change.value as { title: string; createdAt: number };
            task.title = metadata.title;
            task.createdAt = metadata.createdAt;
          } else if (change.kind === "row") {
            // SAFETY: The sync engine validates each row before adding a change page.
            const message = structuredClone(change.value as Message);
            const exists = db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND id = ?").get(threadId, message.id);
            if (!mdb.applySyncedRows(threadId, [message], undefined, db)) continue;
            indexMailRow(task, message);
            if (cached) {
              const at = cached.messages.findIndex((row) => row.id === message.id);
              if (at < 0) this.threads.push(threadId, message);
              else this.threads.put(threadId, at, message);
            }
            events.push(exists ? { type: "message.patch", threadId, message } : { type: "message", threadId, message, imported: true });
          } else if (change.kind === "head") {
            // SAFETY: The sync engine accepts only a string or null for branch heads.
            const leaf = change.value as string | null;
            mdb.applySyncedRows(threadId, [], leaf, db);
            if (cached) cached.activeLeafId = leaf;
            if (leaf) events.push({ type: "thread", threadId, activeLeafId: leaf });
          }
        }
        return changed;
      });
      if (pathChanged) {
        task.resumeCursors = {};
        delete task.lastInstanceId;
        delete task.providerSessionBoundId;
        delete task.resumeSeed;
        if (bot.threadId === threadId) bot.resumeCursors = {};
      }
      bot.tasks?.sort((a, b) => b.createdAt - a.createdAt);
      this.saveBots();
      for (const event of events) this.emit(event);
      this.emit({ type: "bot", botId });
    });
  }

  /** Show an idle bot's task with the newest message; `skip` threads never win.
   * An empty task it leaves is dropped, like a followed import. */
  followNewestTask(botId: string, skip: ReadonlySet<string> = new Set()): boolean {
    const bot = this.bot(botId);
    if (!bot?.tasks || bot.tasks.length < 2 || bot.busy) return false;
    const current = bot.threadId;
    let newest: { threadId: string; at: number } | null = null;
    for (const task of bot.tasks) {
      if (skip.has(task.threadId)) continue;
      const at = mdb.lastMessageAt(task.threadId);
      if (at !== null && (!newest || at > newest.at)) newest = { threadId: task.threadId, at };
    }
    if (!newest || newest.threadId === current) return false;
    const task = this.taskByThread(botId, newest.threadId)!;
    bot.threadId = task.threadId;
    bot.resumeCursors = { ...task.resumeCursors };
    if (!skip.has(current) && mdb.lastMessageAt(current) === null) {
      bot.tasks = bot.tasks.filter((candidate) => candidate.threadId !== current);
      this.deleteThreadRecord(current);
    }
    this.saveBots();
    this.emit({ type: "bot", botId, switched: true });
    return true;
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return null;
    bot.threadId = task.threadId;
    bot.resumeCursors = { ...task.resumeCursors };
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    const task = this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.persistTask(task);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Name a task after its first message, once. */
  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string) {
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    this.persistTask(task);
    this.saveBotsSoon();
    this.emit({ type: "bot", botId });
  }

  /** Delete a task and its transcript. A bot always keeps one. */
  deleteTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot || !bot.tasks || bot.tasks.length < 2) return null;
    if (!bot.tasks.some((t) => t.threadId === threadId)) return null;
    bot.tasks = bot.tasks.filter((t) => t.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    if (bot.threadId === threadId) {
      bot.threadId = bot.tasks[0]!.threadId;
      bot.resumeCursors = { ...bot.tasks[0]!.resumeCursors };
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  /** Drop a task another device deleted; a bot left with none gets a fresh one. */
  removeSyncedTask(botId: string, threadId: string): boolean {
    const bot = this.bot(botId);
    if (!bot?.tasks?.some((t) => t.threadId === threadId)) return false;
    if (bot.tasks.length === 1) {
      bot.tasks.unshift({ threadId: newId(), title: UNTITLED_TASK, createdAt: Date.now(), resumeCursors: {} });
    }
    bot.tasks = bot.tasks.filter((t) => t.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    const switched = bot.threadId === threadId;
    if (switched) {
      bot.threadId = bot.tasks[0]!.threadId;
      bot.resumeCursors = { ...bot.tasks[0]!.resumeCursors };
    }
    this.saveBots();
    this.emit(switched ? { type: "bot", botId, switched: true } : { type: "bot", botId });
    return true;
  }

  /** First-run seed: one bot so the app never opens empty — it gets a
   * random friendly name like every other bot. */
  seedIfEmpty() {
    if (this.bots.length) return;
    this.createBot();
  }
}
