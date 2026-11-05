import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { VERIFY_BRIDGE_ROUTES, VERIFY_GRANT_PREFIX, VERIFY_POLL_MAX_MS, VERIFY_RUN_STATES, type VerifyRunState } from "../electron/verify-protocol.mjs";
import { LIVE_VERIFY_V0, VERIFY_LIMITS, VERIFY_ROUTES, VERIFY_TOOL, VERIFY_TOOL_ENV, type VerifyCardData, type VerifyCardStatus, type VerifyCounts, type VerifyDecision, type VerifyErrorCode, type VerifyResult, type VerifyToolReply } from "../shared/live-verify.ts";
import type { autoVerdict } from "./auto-approve.ts";
import { callerSnapshot } from "./comms-root.ts";
import type { DecisionRow } from "./decision-log.ts";
import { json, readBody } from "./http-helpers.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";
import { VERIFY_REASONS, verifyCardText, verifyReplyText } from "./verify-message.ts";

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
type Decided = VerifyDecision | "stale" | { error: VerifyErrorCode };
interface Run extends VerifyBridgeRun {
  threadId: string;
  turnId: string;
  entryText: string;
  nonce: string;
  held: boolean;
  card: VerifyCardData;
  messageId?: string;
  offerEnds: number;
  claimed: boolean;
  decide?: (decided: Decided) => void;
  live?: { stop: (code: VerifyErrorCode) => void };
  timer?: NodeJS.Timeout;
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
  const payload = JSON.stringify([VERIFY_GRANT_PREFIX, run.botId, run.runId, run.root, run.entry, run.revision, run.expiresAt]);
  return `${Buffer.from(payload).toString("base64url")}.${createHmac("sha256", token).update(payload).digest("base64url")}`;
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
  let slot: string | null = null;
  const enabled = () => LIVE_VERIFY_V0 && (deps.platform ?? process.platform) === "win32";
  const reserve = (runId: string) => (slot === null || slot === runId ? ((slot = runId), true) : false);
  const free = (runId: string) => {
    if (slot === runId) slot = null;
  };
  const turnLive = (run: { threadId: string; turnId: string }) => turnRegistry.current(run.threadId)?.turnId === run.turnId;
  const blocked = (code: VerifyErrorCode, site: string): VerifyToolReply => ({ status: "blocked", errorCode: code, text: verifyReplyText("blocked", site, { errorCode: code }) });

  const drop = (run: Run) => {
    clearTimeout(run.timer);
    free(run.runId);
    if (runs.get(run.runId) === run) runs.delete(run.runId);
  };

  // One current card per owner/thread: a new run takes over the old card and voids its run.
  const writeCard = (run: Run, patch: Partial<VerifyCardData>) => {
    run.card = { ...run.card, ...patch };
    const fields = { text: verifyCardText(run.card), verify: run.card };
    if (run.messageId && store.patchMessage(run.threadId, run.messageId, fields)) return;
    for (const old of runs.values()) if (old !== run && old.botId === run.botId && old.threadId === run.threadId && !old.live) {
      old.decide?.({ error: "cancelled" });
      drop(old);
    }
    const existing = store.activePath(run.threadId).findLast((message) => message.kind === "note" && message.verify?.owner === run.botId);
    if (existing && store.patchMessage(run.threadId, existing.id, fields)) {
      run.messageId = existing.id;
      return;
    }
    const bot = store.bot(run.botId);
    const group = store.conversationForBot(run.botId, run.threadId)?.group;
    run.messageId = store.appendMessage(run.threadId, {
      role: "bot",
      kind: "note",
      ...fields,
      origin: deps.deviceId(),
      ...(group && bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
    }).id;
  };
  const current = (run: Run) => store.messagesFor(run.threadId).find((message) => message.id === run.messageId)?.verify?.runId === run.runId;

  const finish = (run: Run, status: VerifyCardStatus, detail: { result?: VerifyResult | null; errorCode?: VerifyErrorCode; counts?: VerifyCounts | null }): VerifyToolReply => {
    const result = detail.result ?? null;
    const errorCode = detail.errorCode ?? result?.errorCode;
    const counts = result?.counts ?? detail.counts ?? undefined;
    writeCard(run, { status, counts, issues: result?.issues, issueTotal: result?.issueTotal, errorCode, endedAt: Date.now() });
    drop(run);
    return { status, runId: run.runId, ...(result ? { result } : {}), ...(errorCode ? { errorCode } : {}), text: verifyReplyText(status, run.site, { result, errorCode, counts }) };
  };

  /** Starts the approved run on the desktop and waits for its end. Never rejects. */
  const execute = async (run: Run, bridge: VerifyBridge, watch: boolean, signal: AbortSignal | null): Promise<VerifyToolReply> => {
    run.expiresAt = Date.now() + VERIFY_LIMITS.toolMs;
    writeCard(run, { status: "preparing", startedAt: Date.now(), errorCode: undefined, counts: undefined, issues: undefined, issueTotal: undefined, endedAt: undefined });
    const aborter = new AbortController();
    let stopped: VerifyErrorCode | null = null;
    let counts: VerifyCounts | null = null;
    const stop = (code: VerifyErrorCode) => {
      if (stopped) return;
      stopped = code;
      aborter.abort();
      void bridge.cancel(run);
    };
    run.live = { stop };
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const ends = Date.now() + VERIFY_LIMITS.runMs + 10_000;
    const deadline = setTimeout(() => stop("timeout"), ends - Date.now());
    // a held Watch outlives its caller's turn; a tool call does not
    const turnCheck = signal ? setInterval(() => { if (!turnLive(run)) stop("cancelled"); }, TURN_CHECK_MS) : undefined;
    try {
      const started = await bridge.start(run, watch, aborter.signal);
      if (stopped) return finish(run, "blocked", { errorCode: stopped });
      if (started !== "started") return finish(run, "blocked", { errorCode: started });
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
        } else if (counts && Date.now() - sentAt >= COUNTS_EVERY_MS) {
          const stored = store.messagesFor(run.threadId).find((message) => message.id === run.messageId);
          if (stored) deps.broadcastPatch(run.threadId, { ...stored, verify: { ...run.card, counts } });
          sentAt = Date.now();
        }
      }
    } catch {
      return finish(run, "blocked", { errorCode: stopped ?? "internal", counts });
    } finally {
      clearTimeout(deadline);
      clearInterval(turnCheck);
      signal?.removeEventListener("abort", onAbort);
      run.live = undefined;
    }
  };

  const awaitDecision = (run: Run, signal: AbortSignal) => new Promise<Decided | "cancelled">((settle) => {
    const done = (decided: Decided | "cancelled") => {
      clearTimeout(expiry);
      clearInterval(turnCheck);
      signal.removeEventListener("abort", onAbort);
      run.decide = undefined;
      settle(decided);
    };
    const onAbort = () => done("cancelled");
    const expiry = setTimeout(() => done("stale"), run.offerEnds - Date.now());
    const turnCheck = setInterval(() => { if (!turnLive(run)) done("cancelled"); }, TURN_CHECK_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    run.decide = done;
    if (signal.aborted) done("cancelled");
  });

  /** Owner, task, roots and the frozen revision still hold for this offer. */
  const revalidate = async (run: Run): Promise<VerifyErrorCode | null> => {
    const conversation = store.conversationForBot(run.botId, run.threadId);
    if (!conversation || (!run.held && !turnLive(run))) return "cancelled";
    const site = await resolveVerifySite(run.entryText, deps.botOutputRoots(conversation.bot, run.threadId, conversation.group?.id));
    if (typeof site === "string") return site;
    if (site.root !== run.root || site.entry !== run.entry) return "outside-folders";
    return site.revision === run.revision ? null : "site-changed";
  };

  async function handleTool(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    if (!reserve(runId)) return send(blocked("busy", entryText));
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
    const { bot } = conversation;
    const unattended = deps.isUnattended(bot.id);
    const summary = `Check the site ${site.site}`;
    const verdict = deps.autoVerdict(bot, VERIFY_TOOL, summary, { unattended });
    const nonce = randomBytes(16).toString("hex");
    const run: Run = {
      ...site, runId, botId: bot.id, threadId: captured.threadId, turnId: captured.turnId, entryText, nonce, expiresAt: 0,
      held: verdict.approve === null && unattended, claimed: false, offerEnds: 0,
      card: { v: 1, runId, owner: bot.id, site: site.site, status: "offered", mode: verdict.approve === null ? "ask" : "auto", decisionNonce: nonce, offeredAt: Date.now() },
    };
    runs.set(runId, run);
    if (verdict.approve !== null) {
      store.appendMessage(run.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `${verdict.approve}: ${summary.slice(0, 120)}`, ok: true, approval: true },
        ...(conversation.group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
      });
      deps.logDecision({ threadId: run.threadId, requestId: runId, botId: bot.id, botName: bot.name, tool: VERIFY_TOOL, summary, decision: "auto-approved", source: verdict.source, rule: verdict.rule, unattended: unattended || undefined });
      return send(await execute(run, bridge, false, caller.signal));
    }
    if (run.held) {
      // A held offer keeps no page slot; Watch reserves one again.
      free(runId);
      run.offerEnds = Date.now() + VERIFY_LIMITS.heldMs;
      writeCard(run, { errorCode: "needs-approval" });
      run.timer = setTimeout(() => {
        if (run.claimed || runs.get(runId) !== run) return;
        writeCard(run, { status: "stale" });
        drop(run);
      }, VERIFY_LIMITS.heldMs);
      run.timer.unref?.();
      return send({ status: "offered", runId, errorCode: "needs-approval", text: verifyReplyText("offered", run.site, { errorCode: "needs-approval" }) });
    }
    run.offerEnds = Date.now() + VERIFY_LIMITS.askWaitMs;
    writeCard(run, {});
    const decided = await awaitDecision(run, caller.signal);
    if (decided === "watch") return send(await execute(run, bridge, true, caller.signal));
    if (decided === "skip" || decided === "stale") return send(finish(run, decided === "skip" ? "skipped" : "stale", {}));
    return send(finish(run, "blocked", { errorCode: decided === "cancelled" ? "cancelled" : decided.error }));
  }

  async function handleDecision(req: IncomingMessage, res: ServerResponse, runId: string, from: { relay: boolean; phoneSession: boolean }): Promise<void> {
    if (!enabled()) return json(res, 404, { error: "not found" });
    const header = req.headers.authorization;
    if (deps.resolveCommsCaller(header)) return json(res, 403, { error: "forbidden" });
    const client = from.relay
      ? from.phoneSession ? "phone" : null
      : deps.appToken(header)
        ? req.headers["x-openmausbot-companion"] === "1" || deps.remoteClient(req) ? "phone" : "desktop"
        : deps.remoteClient(req) ? "phone" : null;
    if (!client) return json(res, 401, { error: "unauthorized" });
    let body: { action?: unknown; nonce?: unknown };
    try {
      body = await readBody(req);
    } catch (error) {
      return json(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message });
    }
    const action = body?.action;
    if ((action !== "watch" && action !== "skip") || typeof body.nonce !== "string") return json(res, 400, { error: "action and nonce required" });
    const notHere = () => json(res, 404, { error: "not-here" });
    const run = runs.get(runId);
    if (!run || run.nonce !== body.nonce || !current(run)) return notHere();
    if (action === "watch" && client !== "desktop") return json(res, 403, { error: "desktop-required" });
    if (run.live) {
      if (action === "skip") return json(res, 200, { status: run.card.status });
      const bridge = deps.bridge();
      return bridge && await bridge.watch(run) ? json(res, 200, { status: run.card.status }) : notHere();
    }
    if (run.claimed || Date.now() >= run.offerEnds || (!run.held && !run.decide)) return notHere();
    // First valid decision wins; later ones find the offer claimed.
    run.claimed = true;
    if (action === "skip") {
      if (run.decide) run.decide("skip");
      else finish(run, "skipped", {});
      return json(res, 200, { status: "skipped" });
    }
    const problem = await revalidate(run);
    if (problem || runs.get(runId) !== run) {
      if (run.decide) run.decide({ error: problem ?? "cancelled" });
      else if (runs.get(runId) === run) finish(run, "blocked", { errorCode: problem ?? "cancelled" });
      return notHere();
    }
    if (!run.held) {
      if (!run.decide) return notHere();
      run.decide("watch");
      return json(res, 200, { status: "preparing" });
    }
    const bridge = deps.bridge();
    if (!bridge || !reserve(runId)) {
      run.claimed = false;
      return json(res, 409, { error: bridge ? "busy" : "desktop-required" });
    }
    clearTimeout(run.timer);
    // The result lands on the card only; the caller's turn is over, so nothing wakes it.
    void execute(run, bridge, true, null);
    return json(res, 200, { status: "preparing" });
  }

  return { handleTool, handleDecision };
}
