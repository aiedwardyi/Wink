import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { VERIFY_BRIDGE_ROUTES, VERIFY_GRANT_PREFIX, VERIFY_POLL_MAX_MS, VERIFY_RUN_STATES, type VerifyRunState } from "../electron/verify-protocol.mjs";
import { decodeChunks } from "../electron/verify-replay.mjs";
import { LIVE_VERIFY_V0, VERIFY_LIMITS, VERIFY_ROUTES, VERIFY_TOOL, VERIFY_TOOL_ENV, verifyCardStale, type VerifyCardData, type VerifyCardStatus, type VerifyCounts, type VerifyErrorCode, type VerifyResult, type VerifyToolReply } from "../shared/live-verify.ts";
import type { autoVerdict } from "./auto-approve.ts";
import { callerSnapshot } from "./comms-root.ts";
import type { DecisionRow } from "./decision-log.ts";
import { json, readBody } from "./http-helpers.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";
import { VERIFY_REASONS, verifyCardText, verifyProblems, verifyReplyText } from "./verify-message.ts";
import { createReplay, readReplay, replayThread, VERIFY_REPLAYS_DIR } from "./verify-replay.ts";

// Same admission rules as ENGINE's site server (electron/verify-site-server.mjs): both sides must reach one revision.
const SITE_TYPES = new Set([".html", ".htm", ".js", ".mjs", ".css", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".wav", ".mp3", ".mp4", ".webm", ".ttf", ".otf", ".woff", ".woff2"]);
const PRIVATE = /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(?:\..*)?\.json|(?:vite|webpack|eslint|postcss|tailwind)\.config\..*|(?:credentials?|secrets?|tokens?)(?:[._-].*)?)$/i;
const MAX_FILES = 512;
const MAX_FOLDERS = 512;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SITE_BYTES = 64 * 1024 * 1024;
const COUNTS_EVERY_MS = 1_000;
const TURN_CHECK_MS = 1_000;
const DECISION_PATH = new RegExp(`^${VERIFY_ROUTES.decision.replace(":runId", "([a-z0-9-]{8,64})")}$`);

export interface VerifyBridgeRun { botId: string; runId: string; root: string; entry: string; revision: string; site: string; expiresAt: number }
export interface VerifyBridge {
  start(run: VerifyBridgeRun, watch: boolean, signal: AbortSignal): Promise<"started" | VerifyErrorCode>;
  /** null when main no longer knows the run */
  poll(run: VerifyBridgeRun, since: number, waitMs: number, signal: AbortSignal): Promise<VerifyRunState | null>;
  watch(run: VerifyBridgeRun): Promise<boolean>;
  cancel(run: VerifyBridgeRun): Promise<void>;
  cast?(run: VerifyBridgeRun, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
}

export interface VerifySiteDeps {
  store: Store;
  resolveCommsCaller: (header: string | string[] | undefined) => { botId: string; threadId: string } | undefined;
  botOutputRoots: (bot: BotRecord, threadId: string, groupId?: string) => string[];
  autoVerdict: typeof autoVerdict;
  isUnattended: (botId: string) => boolean;
  /** null without a desktop terminal bridge */
  bridge: () => VerifyBridge | null;
  /** an SSE-only message.patch; counts never touch disk */
  broadcastPatch: (threadId: string, message: Message) => void;
  logDecision: (row: Omit<DecisionRow, "at">) => void;
  deviceId: () => string;
  /** the desktop app's own bearer, never a scoped comms caller */
  appToken: (header: string | string[] | undefined) => boolean;
  /** the tailnet remote host or its cookie */
  remoteClient: (req: IncomingMessage) => boolean;
  platform?: NodeJS.Platform;
}

interface Site { root: string; entry: string; revision: string; site: string }
interface Run extends VerifyBridgeRun {
  threadId: string;
  turnId: string;
  nonce: string;
  card: VerifyCardData;
  messageId?: string;
  live?: { stop: (code: VerifyErrorCode) => void };
  recording?: ReturnType<typeof createReplay>;
  stream?: Promise<void>;
  toolDeadline?: number;
  saved?: Promise<void>;
  streamEnd?: Record<string, unknown>;
  cancelled?: boolean;
  replySent?: Promise<void>;
}

const within = (root: string, path: string) => {
  const a = process.platform === "win32" ? root.toLowerCase() : root;
  const b = process.platform === "win32" ? path.toLowerCase() : path;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
};
const siteName = (rel: string) => rel.length > 0 && !/[\\:%\x00-\x1f\x7f]/.test(rel) && rel.split("/").every((part) => part && !part.startsWith(".") && !/[. ]$/.test(part) && !PRIVATE.test(part));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const siteError = (code: VerifyErrorCode) => Object.assign(new Error(code), { code });

/** The frozen revision: sorted [relative path, sha256] pairs of every admitted file. */
async function siteRevision(root: string, entry: string): Promise<string> {
  const files: Array<[string, string]> = [];
  let total = 0;
  let folders = 0;
  const walk = async (dir: string, prefix: string) => {
    if (++folders > MAX_FOLDERS) throw siteError("resource-limit");
    if (!within(root, await realpath(dir))) throw siteError("outside-folders");
    for (const name of await readdir(dir)) {
      const rel = prefix + name;
      if (!siteName(rel)) throw siteError("not-a-site");
      const path = join(dir, name);
      if (!within(root, await realpath(path))) throw siteError("outside-folders");
      const info = await stat(path);
      if (info.isDirectory()) {
        await walk(path, `${rel}/`);
        continue;
      }
      if (!info.isFile() || !SITE_TYPES.has(extname(name).toLowerCase())) throw siteError("not-a-site");
      if (files.length >= MAX_FILES || info.size > MAX_FILE_BYTES) throw siteError("resource-limit");
      const handle = await open(path, "r");
      try {
        const bytes = await handle.readFile();
        total += bytes.length;
        if (bytes.length > MAX_FILE_BYTES || total > MAX_SITE_BYTES) throw siteError("resource-limit");
        files.push([rel, sha256(bytes)]);
      } finally {
        await handle.close();
      }
    }
  };
  await walk(root, "");
  if (!files.some(([rel]) => rel === entry)) throw siteError("not-a-site");
  return sha256(JSON.stringify(files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** Canonical served root, entry and revision for an owned site, or why it is refused. */
export async function resolveVerifySite(entryText: string, roots: string[]): Promise<Site | VerifyErrorCode> {
  // UNC, device, drive-relative and stream paths never name an owned folder.
  if (/[\x00-\x1f]/.test(entryText) || /^[\\/]{2}/.test(entryText) || /^[a-zA-Z]:(?![\\/])/.test(entryText) || entryText.replace(/^[a-zA-Z]:/, "").includes(":")) return "outside-folders";
  if (!roots.length) return "outside-folders";
  const target = resolve(roots[0]!, entryText);
  const owned = (await Promise.all(roots.map((root) => realpath(root).catch(() => null)))).filter((root): root is string => root !== null);
  if (!roots.some((root) => within(resolve(root), target)) && !owned.some((root) => within(root, target))) return "outside-folders";
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return "not-a-site";
  }
  if (!owned.some((root) => within(root, real))) return "outside-folders";
  const info = await stat(real);
  const [root, entry] = info.isDirectory() ? [real, "index.html"] : info.isFile() && /\.html?$/i.test(real) ? [dirname(real), basename(real)] : [null, null];
  if (!root || !entry) return "not-a-site";
  const owner = owned.find((candidate) => within(candidate, root));
  if (!owner) return "outside-folders";
  try {
    const revision = await siteRevision(root, entry);
    return { root, entry, revision, site: relative(owner, join(root, entry)).split(sep).join("/") };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "resource-limit" || code === "outside-folders" ? code : "not-a-site";
  }
}

/** The frozen bridge grant (V0.md "Bridge auth rule"). */
export function verifyGrant(token: string, run: VerifyBridgeRun): string {
  const payload = Buffer.from(JSON.stringify([VERIFY_GRANT_PREFIX, run.botId, run.runId, run.root, run.entry, run.revision, run.expiresAt])).toString("base64url");
  return `${payload}.${createHmac("sha256", token).update(payload).digest("base64url")}`;
}

export function verifyBridgeClient(access: { url: string; token: string }): VerifyBridge {
  const call = (route: string, run: VerifyBridgeRun, init: RequestInit & { query?: string } = {}) =>
    fetch(`${access.url}${route.replace(":botId", encodeURIComponent(run.botId)).replace(":runId", encodeURIComponent(run.runId))}${init.query ?? ""}`, {
      ...init,
      redirect: "error",
      headers: { authorization: `Bearer ${verifyGrant(access.token, run)}`, "content-type": "application/json" },
    });
  return {
    async start(run, watch, signal) {
      const { runId, root, entry, revision, site } = run;
      const res = await call(VERIFY_BRIDGE_ROUTES.start, run, { method: "POST", body: JSON.stringify({ runId, root, entry, revision, site, watch }), signal });
      if (res.status === 202) return "started";
      const error = ((await res.json().catch(() => ({}))) as { error?: unknown }).error;
      return typeof error === "string" && Object.hasOwn(VERIFY_REASONS, error) ? error as VerifyErrorCode : "internal";
    },
    async poll(run, since, waitMs, signal) {
      const res = await call(VERIFY_BRIDGE_ROUTES.poll, run, { query: `?since=${since}&waitMs=${waitMs}`, signal: AbortSignal.any([signal, AbortSignal.timeout(waitMs + 10_000)]) });
      if (res.status === 404) return null;
      const state = (await res.json()) as VerifyRunState;
      if (!res.ok || !VERIFY_RUN_STATES.includes(state?.state as VerifyRunState["state"]) || !Number.isSafeInteger(state.revision)) throw new Error(`verify poll failed: HTTP ${res.status}`);
      return state;
    },
    async watch(run) {
      return (await call(VERIFY_BRIDGE_ROUTES.watch, run, { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => null))?.ok === true;
    },
    async cancel(run) {
      await call(VERIFY_BRIDGE_ROUTES.cancel, run, { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    },
    async cast(run, signal) {
      const res = await call(VERIFY_BRIDGE_ROUTES.cast, run, { signal });
      return res.ok ? res.body : null;
    },
  };
}

/** The agents MCP lists verify_site only on a Windows desktop with the switch on. */
export function verifyToolEnv(desktop: boolean, platform: NodeJS.Platform = process.platform): Record<string, string> {
  return LIVE_VERIFY_V0 && desktop && platform === "win32" ? { [VERIFY_TOOL_ENV]: "1" } : {};
}

export function verifyDecisionRunId(path: string): string | null {
  return DECISION_PATH.exec(path)?.[1] ?? null;
}

export function createVerifySite(deps: VerifySiteDeps) {
  const { store } = deps;
  const runs = new Map<string, Run>();
  const queue: Array<() => void> = [];
  let slot: string | null = null;
  const enabled = () => LIVE_VERIFY_V0 && (deps.platform ?? process.platform) === "win32";
  const reserve = (runId: string) => (slot === null || slot === runId ? ((slot = runId), true) : false);
  const free = (runId: string) => {
    if (slot === runId) { slot = null; queue.shift()?.(); }
  };
  const acquire = (runId: string, signal?: AbortSignal, ends = Date.now() + VERIFY_LIMITS.runMs) => new Promise<boolean>(resolve => {
    if (signal?.aborted || Date.now() >= ends) { resolve(false); return; }
    if (!queue.length && reserve(runId)) { resolve(true); return; }
    if (queue.length >= 2) { resolve(false); return; }
    const finish = (granted: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const index = queue.indexOf(enter);
      if (index >= 0) queue.splice(index, 1);
      resolve(granted);
    };
    const enter = () => finish(reserve(runId));
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, Math.max(1, ends - Date.now()));
    queue.push(enter);
    signal?.addEventListener("abort", cancel, { once: true });
  });
  const turnLive = (run: { threadId: string; turnId: string }) => turnRegistry.current(run.threadId)?.turnId === run.turnId;
  const blocked = (code: VerifyErrorCode, site: string): VerifyToolReply => ({ status: "blocked", errorCode: code, text: verifyReplyText("blocked", site, { errorCode: code }) });
  const replySent = (res: ServerResponse) => res.writableFinished || res.destroyed ? Promise.resolve() : new Promise<void>(resolve => { res.once("finish", () => resolve()); res.once("close", () => resolve()); });

  const drop = (run: Run) => {
    if (run.cancelled && run.stream) void run.stream.finally(() => free(run.runId));
    else free(run.runId);
    if (!run.recording && runs.get(run.runId) === run) runs.delete(run.runId);
  };

  const writeCard = (run: Run, patch: Partial<VerifyCardData>) => {
    run.card = { ...run.card, ...patch };
    const bot = store.bot(run.botId);
    const group = store.conversationForBot(run.botId, run.threadId)?.group;
    const fields = { text: verifyCardText(run.card), verify: run.card, quiet: true as const, ...(group && bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}) };
    if (run.messageId && store.patchMessage(run.threadId, run.messageId, fields)) return;
    const existing = store.activePath(run.threadId).findLast((message) => message.kind === "note" && message.verify?.owner === run.botId);
    if (existing && store.patchMessage(run.threadId, existing.id, fields)) {
      run.messageId = existing.id;
      return;
    }
    run.messageId = store.appendMessage(run.threadId, {
      role: "bot",
      kind: "note",
      ...fields,
      origin: deps.deviceId(),
      ...(group && bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
    }).id;
  };

  const patchCard = (run: Run, patch: Partial<VerifyCardData>) => {
    const stored = store.messagesFor(run.threadId).find(message => message.id === run.messageId);
    if (stored?.verify?.runId === run.runId) deps.broadcastPatch(run.threadId, { ...stored, verify: { ...stored.verify, ...patch } });
  };

  const finish = (run: Run, status: VerifyCardStatus, detail: { result?: VerifyResult | null; errorCode?: VerifyErrorCode; counts?: VerifyCounts | null }): VerifyToolReply => {
    const result = detail.result ?? null;
    const errorCode = detail.errorCode ?? result?.errorCode;
    const counts = result?.counts ?? detail.counts ?? undefined;
    const issues = result ? verifyProblems(result.issues) : undefined;
    const details = result ? [...(result.details ?? []), ...result.issues.filter(row => !issues!.includes(row))].slice(0, VERIFY_LIMITS.issues) : undefined;
    if (run.recording) {
      run.saved = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        await run.replySent;
        await run.stream;
        run.recording!.finish({ status, ms: typeof run.streamEnd?.ms === "number" ? run.streamEnd.ms : result?.durationMs ?? Math.max(0, Date.now() - (run.card.startedAt ?? run.card.offeredAt)), issues: issues ?? [], notChecked: result?.notChecked ?? [] });
        const kept = await run.recording!.save(VERIFY_REPLAYS_DIR, run.threadId, run.messageId!);
        const replay = kept.get(`${run.threadId}/${run.messageId}`) ?? [];
        patchCard(run, { replay });
      }).catch(() => {}).finally(() => { if (runs.get(run.runId) === run) runs.delete(run.runId); });
    }
    try {
      writeCard(run, { status, counts, issues, issueTotal: issues?.length, notChecked: result?.notChecked, details, errorCode, endedAt: Date.now() });
      if (run.recording) patchCard(run, { live: undefined });
    } catch {
      return blocked("internal", run.site);
    } finally {
      drop(run);
    }
    return { status, runId: run.runId, ...(result ? { result } : {}), ...(errorCode ? { errorCode } : {}), text: verifyReplyText(status, run.site, { result, errorCode, counts }) };
  };

  const execute = async (run: Run, bridge: VerifyBridge, watch: boolean, signal: AbortSignal | null): Promise<VerifyToolReply> => {
    run.expiresAt = Date.now() + VERIFY_LIMITS.toolMs;
    const aborter = new AbortController();
    let stopped: VerifyErrorCode | null = null;
    let counts: VerifyCounts | null = null;
    const stop = (code: VerifyErrorCode) => {
      if (stopped) return;
      stopped = code;
      run.cancelled = true;
      aborter.abort();
      void bridge.cancel(run);
    };
    run.live = { stop };
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const ends = run.toolDeadline ?? Date.now() + VERIFY_LIMITS.runMs;
    const deadline = setTimeout(() => stop("timeout"), Math.max(1, ends - Date.now()));
    const turnCheck = signal ? setInterval(() => { if (!turnLive(run)) stop("cancelled"); }, TURN_CHECK_MS) : undefined;
    try {
      writeCard(run, { status: "preparing", startedAt: Date.now(), errorCode: undefined, counts: undefined, issues: undefined, issueTotal: undefined, notChecked: undefined, details: undefined, endedAt: undefined });
      const started = await bridge.start(run, watch, aborter.signal);
      if (stopped) return finish(run, "blocked", { errorCode: stopped });
      if (started !== "started") return finish(run, "blocked", { errorCode: started });
      if (bridge.cast) {
        run.recording = createReplay({ v: 1, runId: run.runId, site: run.site, page: run.entry, startedAt: run.card.startedAt, tiles: { desktop: [1280, 720], phone: [392, 800] } });
        patchCard(run, { live: true });
        run.stream = (async () => {
          const stream = await bridge.cast!(run, AbortSignal.timeout(Math.max(1, ends - Date.now() + 5000)));
          if (!stream) return;
          const reader = stream.getReader(), decoder = decodeChunks(value => { if (value.kind < 3) run.recording!.add(value.raw); else run.streamEnd = value.value; });
          try { for (;;) { const next = await reader.read(); if (next.done) break; decoder.push(next.value); } decoder.end(); }
          finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        })().catch(() => {});
      }
      let since = 0;
      let sentAt = 0;
      while (true) {
        const state = await bridge.poll(run, since, Math.max(0, Math.min(VERIFY_POLL_MAX_MS, ends - Date.now())), aborter.signal);
        if (stopped) return finish(run, "blocked", { errorCode: stopped, counts });
        if (!state) return finish(run, "blocked", { errorCode: "internal", counts });
        since = state.revision;
        if (state.counts) counts = state.counts;
        if (state.state === "completed" || state.state === "blocked") {
          const errorCode = state.result?.errorCode ?? (state.state === "blocked" ? state.errorCode ?? "internal" : undefined);
          return finish(run, errorCode ? "blocked" : "completed", { result: state.result, errorCode, counts });
        }
        if (state.state === "running" && run.card.status !== "running") {
          writeCard(run, { status: "running", counts: counts ?? undefined });
          if (run.recording) patchCard(run, { live: true });
        } else if (counts && Date.now() - sentAt >= COUNTS_EVERY_MS) {
          const stored = store.messagesFor(run.threadId).find((message) => message.id === run.messageId);
          if (stored) deps.broadcastPatch(run.threadId, { ...stored, verify: { ...run.card, counts, ...(run.recording ? { live: true } : {}) } });
          sentAt = Date.now();
        }
      }
    } catch {
      stop(stopped ?? "internal");
      return finish(run, "blocked", { errorCode: stopped ?? "internal", counts });
    } finally {
      clearTimeout(deadline);
      clearInterval(turnCheck);
      signal?.removeEventListener("abort", onAbort);
      run.live = undefined;
    }
  };

  async function handleTool(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const toolDeadline = Date.now() + VERIFY_LIMITS.runMs;
    if (!enabled()) return json(res, 404, { error: "not found" });
    const scoped = deps.resolveCommsCaller(req.headers.authorization);
    const captured = scoped ? callerSnapshot(scoped.botId, scoped.threadId) : null;
    if (!scoped) return json(res, 403, { error: "unknown sender" });
    if (!captured) return json(res, 409, { error: "This turn has ended, so it can't run Live Verify." });
    if (captured.depth > 0) return json(res, 403, { error: `${VERIFY_TOOL} is unavailable in peer turns.` });
    // A request body that ends normally closes req too; only a dropped connection cancels.
    const caller = new AbortController();
    req.once("aborted", () => caller.abort());
    res.once("close", () => { if (!res.writableEnded) caller.abort(); });
    let body: { entry?: unknown };
    try {
      body = await readBody(req);
    } catch (error) {
      return json(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message });
    }
    const entryText = typeof body?.entry === "string" ? body.entry.trim() : "";
    if (!entryText || entryText.length > VERIFY_LIMITS.entryChars) return json(res, 400, { error: `entry must be 1 to ${VERIFY_LIMITS.entryChars} characters` });
    const send = (reply: VerifyToolReply) => { if (!res.writableEnded && !res.destroyed) json(res, 200, reply); };
    const conversation = store.conversationForBot(captured.botId, captured.threadId);
    if (!conversation) return json(res, 403, { error: "source thread does not belong to sender" });
    const bridge = deps.bridge();
    if (!bridge) return send(blocked("desktop-required", entryText));
    const runId = randomUUID();
    let site: Site | VerifyErrorCode;
    try {
      site = await resolveVerifySite(entryText, deps.botOutputRoots(conversation.bot, captured.threadId, conversation.group?.id));
    } catch {
      site = "not-a-site";
    }
    if (typeof site === "string" || caller.signal.aborted || !turnLive(captured)) {
      free(runId);
      return send(blocked(typeof site === "string" ? site : "cancelled", typeof site === "string" ? entryText : site.site));
    }
    const nonce = randomBytes(16).toString("hex");
    const run: Run = {
      ...site, runId, botId: captured.botId, threadId: captured.threadId, turnId: captured.turnId, nonce, expiresAt: 0, toolDeadline, replySent: replySent(res),
      card: { v: 1, runId, owner: captured.botId, site: site.site, entry: join(site.root, site.entry), status: "preparing", mode: "auto", decisionNonce: nonce, offeredAt: Date.now() },
    };
    runs.set(runId, run);
    if (slot !== null) writeCard(run, { status: "waiting" });
    if (!await acquire(runId, caller.signal, toolDeadline)) return send(finish(run, "blocked", { errorCode: caller.signal.aborted ? "cancelled" : Date.now() >= toolDeadline ? "timeout" : "busy" }));
    if (!turnLive(run)) return send(finish(run, "blocked", { errorCode: "cancelled" }));
    return send(await execute(run, bridge, false, caller.signal));
  }

  async function handleDecision(req: IncomingMessage, res: ServerResponse, runId: string, from: { relay: boolean; phoneSession: boolean }): Promise<void> {
    const toolDeadline = Date.now() + VERIFY_LIMITS.runMs;
    if (!enabled()) return json(res, 404, { error: "not found" });
    const header = req.headers.authorization;
    if (deps.resolveCommsCaller(header)) return json(res, 403, { error: "forbidden" });
    const client = from.relay
      ? from.phoneSession ? "phone" : null
      : deps.appToken(header)
        ? req.headers["x-openmausbot-companion"] === "1" || deps.remoteClient(req) ? "phone" : "desktop"
        : deps.remoteClient(req) ? "phone" : null;
    if (!client) return json(res, 401, { error: "unauthorized" });
    let body: { action?: unknown; nonce?: unknown; threadId?: unknown; owner?: unknown };
    try {
      body = await readBody(req);
    } catch (error) {
      return json(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message });
    }
    if (body.action !== "rerun" || typeof body.nonce !== "string" || typeof body.threadId !== "string" || typeof body.owner !== "string") return json(res, 400, { error: "rerun, nonce, owner and threadId required" });
    const conversation = store.conversationForBot(body.owner, body.threadId);
    if (!conversation) return json(res, 404, { error: "not-here" });
    const previous = store.activePath(body.threadId).findLast(message => message.verify?.runId === runId && message.verify.owner === body.owner)?.verify;
    if (!previous || previous.decisionNonce !== body.nonce || runs.has(runId) || (["running", "preparing", "waiting"].includes(previous.status) && !verifyCardStale(previous, Date.now()))) return json(res, 404, { error: "not-here" });
    const bridge = deps.bridge();
    if (!bridge) return json(res, 409, { error: "desktop-required" });
    const nextId = randomUUID();
    try {
      const roots = deps.botOutputRoots(conversation.bot, body.threadId, conversation.group?.id);
      const site = await resolveVerifySite(previous.entry ?? previous.site, roots);
      const currentCard = store.activePath(body.threadId).findLast(message => message.verify?.owner === body.owner)?.verify;
      if (typeof site === "string" || currentCard?.runId !== runId || currentCard.decisionNonce !== body.nonce) {
        free(nextId);
        return json(res, 409, { error: typeof site === "string" ? site : "not-here" });
      }
      const nonce = randomBytes(16).toString("hex");
      const run: Run = {
        ...site, runId: nextId, botId: body.owner, threadId: body.threadId, turnId: "", nonce, expiresAt: 0, toolDeadline, replySent: replySent(res),
        card: { v: 1, runId: nextId, owner: body.owner, site: site.site, entry: join(site.root, site.entry), status: "preparing", mode: "auto", decisionNonce: nonce, offeredAt: Date.now() },
      };
      runs.set(nextId, run);
      if (slot !== null) writeCard(run, { status: "waiting" });
      if (!await acquire(nextId, undefined, toolDeadline)) {
        finish(run, "blocked", { errorCode: Date.now() >= toolDeadline ? "timeout" : "busy" });
        return json(res, 409, { error: "busy" });
      }
      void execute(run, bridge, false, null);
      return json(res, 200, { status: "preparing" });
    } catch {
      free(nextId);
      return json(res, 409, { error: "not-a-site" });
    }
  }

  async function handleStream(req: IncomingMessage, res: ServerResponse, runId: string, replay: boolean, from: { relay: boolean; phoneSession: boolean }): Promise<void> {
    res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff");
    if (!enabled()) return json(res, 404, { error: "not found" });
    if (deps.resolveCommsCaller(req.headers.authorization)) return json(res, 403, { error: "forbidden" });
    if (from.relay ? !from.phoneSession : !deps.appToken(req.headers.authorization) && !deps.remoteClient(req)) return json(res, 401, { error: "unauthorized" });
    const run = runs.get(runId), threadId = run?.threadId ?? await replayThread(runId);
    if (!threadId || !store.botByThread(threadId) && !store.groupByThread(threadId)) return json(res, 404, { error: "not-here" });
    if (!replay && run?.recording && !run.card.endedAt) {
      let blocked = false, opened = false;
      res.on("drain", () => { blocked = false; });
      try {
        const close = run.recording.subscribe(bytes => {
          if (!opened) { opened = true; res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" }); }
          if (res.destroyed || res.writableEnded || blocked && bytes[4] === 1) return false;
          if (!res.write(bytes)) blocked = true;
          if (bytes[4] === 3) res.end();
          return true;
        });
        res.once("close", close);
      } catch { json(res, 429, { error: "busy" }); }
      return;
    }
    await run?.saved;
    const bytes = await readReplay(threadId, runId);
    if (!bytes) return json(res, 404, { error: "not-here" });
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(bytes);
  }

  return { handleTool, handleDecision, handleStream };
}
