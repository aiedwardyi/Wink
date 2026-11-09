import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { chunk } from "../electron/verify-replay.mjs";
import type { VerifyCardData, VerifyCardStatus } from "../shared/live-verify.ts";
import { VERIFY_DOC_FINDINGS, type VerifyDocFinding, type VerifyDocMark } from "../shared/verify-doc.ts";
import type { ProviderInstance } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message, Store } from "./store.ts";
import { chunkDoc, chunkPrompt, dateClashes, DOC_EXTS, docText, findingAt, fixPrompt, lineIndex, mergePrompt, nameTwins, numberingHits, parseChunkReply, parseMergeReply, readDoc, type DocChunk, type DocHit, type DocText } from "./verify-doc-text.ts";
import { verifyCardText } from "./verify-message.ts";
import { createReplay, VERIFY_REPLAYS_DIR } from "./verify-replay.ts";

const QUIET_MS = 3_000;
const CALL_MS = 90_000;
const CHECK_MS = 6 * 60_000;
const AT_ONCE = 3;
const MIN_CHARS = 1_000;
const CAP_CHARS = 300_000;
const MAX_BYTES = 32 * 1024 * 1024;
const PULSE_MS = 1_000;
const BEAT_MS = 5_000;
// A reload reads the stored card; it must move inside verifyCardStale's 70 s.
const SAVE_MS = 30_000;
const WAITING = 4;
const KEPT = 50;
const CACHED_FILES = 12;
const FIX_ROUNDS = 2;
const NEAR = 16;
// Files a bot keeps for itself or a codebase, not documents written for a person.
const DEV = /^(?:readme|changelog|changes|contributing|licen[cs]e|copying|code_of_conduct|security|notice|authors|claude|agents|gemini|memory|skill)(?:\.[a-z]+)?$|^requirements.*\.txt$|^(?:robots|cmakelists)\.txt$/i;
const PROJECT = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", ".git"];

export interface DocStart { botId: string; threadId: string; roots: string[]; paths: string[]; humanId?: string }
export interface VerifyDocDeps {
  store: Pick<Store, "bot" | "conversationForBot" | "appendMessage" | "patchMessage" | "messagesFor">;
  instanceFor: (botId: string, threadId: string) => Pick<ProviderInstance, "generateText"> | null | undefined;
  /** the bot has a turn going */
  busy: (botId: string, threadId: string) => boolean;
  /** starts the bot's fix turn; false when the bot is busy, `failed` when it never dispatched, a queued turn dispatches only when `ready` */
  fix: (botId: string, threadId: string, prompt: string, failed: () => void, ready: () => Promise<boolean>) => Promise<boolean>;
  deviceId: () => string;
  /** an SSE-only message.patch */
  broadcastPatch: (threadId: string, message: Message) => void;
  log: (line: string) => void;
  quietMs?: number;
}

interface Picked { file: string; site: string; doc: DocText; sha: string; cut: number }
interface Parsed { hits: DocHit[]; names: string[]; dates: string[] }
interface Run { runId: string; threadId: string; card: VerifyCardData; recording: ReturnType<typeof createReplay>; aborter: AbortController; messageId?: string; saved?: Promise<void> }
interface Slot { token: object; input?: DocStart; timer?: ReturnType<typeof setTimeout>; run?: Run; orphan?: string }
// One user turn's fix rounds on one file; `token` marks its fix turn once asked to start, `listed` the latest round's findings.
interface Fix { botId: string; humanId: string; roots: string[]; file: string; sha: string; rounds: number; handed: Map<string, { row: VerifyDocFinding; near: string[] }>; listed: string[]; fixing: boolean; prompt?: string; messageId?: string; token?: string; timer?: ReturnType<typeof setTimeout> }

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const findingKey = (row: VerifyDocFinding) => `${row.kind}\n${row.quote}\n${row.fix}`;
const slipKey = (row: VerifyDocFinding) => `${row.kind}\n${row.quote}`;
const flat = (text: string) => text.replace(/\s+/g, " ");
const remember = <V>(map: Map<string, V>, key: string, value: V, max: number) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
};

async function inProject(folder: string, root: string): Promise<boolean> {
  for (let dir = folder; ; dir = dirname(dir)) {
    for (const name of PROJECT) if (await stat(join(dir, name)).catch(() => null)) return true;
    if (!relative(root, dir) || dirname(dir) === dir) return false;
  }
}

export function createVerifyDoc(deps: VerifyDocDeps) {
  const { store } = deps, quietMs = deps.quietMs ?? QUIET_MS;
  const slots = new Map<string, Slot>(), runs = new Map<string, Run>();
  const checked = new Map<string, { sha: string; keys: Set<string> }>(), caches = new Map<string, Map<string, Parsed>>(), fixes = new Map<string, Fix>(), budgets = new Map<string, Fix>();
  let chain = Promise.resolve(), waiting = 0, disposed = false;

  const writeCard = (botId: string, run: Run) => {
    const bot = store.bot(botId), group = store.conversationForBot(botId, run.threadId)?.group;
    const fields = { text: verifyCardText(run.card), verify: run.card, quiet: true as const, ...(group && bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}) };
    if (run.messageId && store.patchMessage(run.threadId, run.messageId, fields)) return;
    run.messageId = store.appendMessage(run.threadId, { role: "bot", kind: "note", ...fields, origin: deps.deviceId() }).id;
  };
  const patchCard = (run: Run, patch: Partial<VerifyCardData>) => {
    const stored = store.messagesFor(run.threadId).find(message => message.id === run.messageId);
    if (stored?.verify?.runId === run.runId) deps.broadcastPatch(run.threadId, { ...stored, verify: { ...run.card, ...patch } });
  };
  // The card of a replaced check would spin until stale when the next check does not run.
  const dropOrphan = (slot: Slot, threadId: string) => {
    const stored = slot.orphan ? store.messagesFor(threadId).find(message => message.id === slot.orphan)?.verify : undefined;
    if (stored) {
      const card: VerifyCardData = { ...stored, status: "blocked", errorCode: "cancelled", endedAt: Date.now() };
      store.patchMessage(threadId, slot.orphan!, { text: verifyCardText(card), verify: card });
    }
    slot.orphan = undefined;
  };
  const unfix = (threadId: string) => {
    const fx = fixes.get(threadId);
    if (!fx?.fixing) return;
    clearTimeout(fx.timer);
    fx.fixing = false;
    fx.timer = fx.token = undefined;
    const stored = fx.messageId ? store.messagesFor(threadId).find(message => message.id === fx.messageId)?.verify : undefined;
    if (stored?.doc?.fixing) {
      const card: VerifyCardData = { ...stored, doc: { ...stored.doc, fixing: undefined } };
      store.patchMessage(threadId, fx.messageId!, { text: verifyCardText(card), verify: card });
    }
  };
  // A round dropped before its turn started never reached the bot: its findings and the round stay unspent.
  const giveBack = (threadId: string) => {
    const fx = fixes.get(threadId);
    if (!fx?.fixing || !fx.listed.length) return;
    fx.rounds--;
    for (const key of fx.listed) fx.handed.delete(key);
    fx.listed = [];
  };
  // The user can change or remove the file while the fix waits; a fix only lands on what was checked.
  const current = async (threadId: string, fx: Fix) => {
    const now = await pick({ botId: fx.botId, threadId, roots: fx.roots, paths: [fx.file] });
    if (disposed || fixes.get(threadId) !== fx || !fx.fixing) return false;
    if (now?.file === fx.file && now.sha === fx.sha) return true;
    giveBack(threadId);
    unfix(threadId);
    fixes.delete(threadId);
    schedule({ botId: fx.botId, threadId, roots: fx.roots, paths: [fx.file], humanId: fx.humanId });
    return false;
  };
  // Like a pane wake, the fix turn waits for the bot; a user message sent meanwhile goes first.
  const hand = async (threadId: string, fx: Fix) => {
    fx.timer = undefined;
    if (disposed || fixes.get(threadId) !== fx || !fx.fixing) return;
    if (deps.busy(fx.botId, threadId)) { fx.timer = setTimeout(hand, quietMs, threadId, fx); return; }
    if (!await current(threadId, fx)) return;
    const token = fx.token = randomUUID();
    const ready = async () => fx.token === token && await current(threadId, fx) && fx.token === token;
    deps.fix(fx.botId, threadId, fx.prompt!, () => { if (fixes.get(threadId) === fx && fx.token === token) unfix(threadId); }, ready).then(started => {
      if (started || fixes.get(threadId) !== fx || fx.token !== token) return;
      fx.token = undefined;
      fx.timer = setTimeout(hand, quietMs, threadId, fx);
    }, error => {
      deps.log(`Live Verify: no fix turn in ${threadId}: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
      if (fixes.get(threadId) === fx) unfix(threadId);
    });
  };

  async function pick(input: DocStart): Promise<Picked | null> {
    const roots = (await Promise.all(input.roots.map(root => realpath(root).catch(() => null)))).filter(root => root !== null);
    const owner = (path: string) => roots.find(root => {
      const rel = relative(root, path);
      return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
    });
    const files = (await Promise.all([...new Set(input.paths)].map(async path => {
      const full = await realpath(resolve(input.roots[0]!, path)).catch(() => null), root = full ? owner(full) : undefined;
      if (!full || !root) return null;
      const rel = relative(root, full), ext = extname(full).toLowerCase();
      if (!DOC_EXTS.has(ext) || DEV.test(basename(full)) || rel.split(sep)[0]!.toLowerCase() === "memory") return null;
      const info = await stat(full).catch(() => null);
      if (!info?.isFile() || info.size > MAX_BYTES || ext !== ".docx" && await inProject(dirname(full), root)) return null;
      return { full, site: rel.split(sep).join("/"), mtime: info.mtimeMs };
    }))).filter(row => row !== null).sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      try {
        const { raw, rendered } = await readDoc(file.full);
        const end = raw.length > CAP_CHARS ? raw.lastIndexOf("\n", CAP_CHARS) : raw.length;
        const kept = raw.slice(0, end > 0 ? end : CAP_CHARS), doc = docText(kept, rendered);
        if (doc.text.trim().length >= MIN_CHARS) return { file: file.full, site: file.site, doc, sha: sha256(doc.text), cut: raw.length - kept.length };
      } catch { deps.log(`Live Verify: could not read a document in ${input.threadId}`); }
    }
    return null;
  }

  async function check(slot: Slot, input: DocStart, token: object): Promise<void> {
    const { botId, threadId } = input;
    const picked = await pick(input);
    if (slot.token !== token || disposed) return;
    const engine = picked ? deps.instanceFor(botId, threadId) : null;
    if (picked && !engine?.generateText) deps.log(`Live Verify: no text engine for ${threadId}`);
    giveBack(threadId);
    unfix(threadId);
    if (!picked || !engine?.generateText || checked.get(`${threadId}\n${picked.file}`)?.sha === picked.sha) return dropOrphan(slot, threadId);
    const { file, site, doc, sha, cut } = picked, generate = engine.generateText.bind(engine);
    const humanId = input.humanId ?? "", budget = `${threadId}\n${humanId}\n${file}`;
    let fx = budgets.get(budget);
    const parts = chunkDoc(doc), startedAt = Date.now(), runId = randomUUID();
    const run: Run = {
      runId, threadId, messageId: slot.orphan ?? fx?.messageId, aborter: new AbortController(),
      recording: createReplay({ v: 1, runId, site, page: site, startedAt, tiles: { desktop: [1280, 720], phone: [392, 800] } }),
      card: {
        v: 1, runId, owner: botId, site, entry: file, status: "running", mode: "auto", decisionNonce: randomBytes(16).toString("hex"), offeredAt: startedAt, startedAt,
        doc: { pages: doc.pageCount, lines: doc.lineStarts.length, chunks: [0, parts.length], page: 1, beat: startedAt, by: {}, ...(cut ? { cut } : {}) },
      },
    };
    const live = run.card.doc!, signal = run.aborter.signal;
    slot.orphan = undefined;
    slot.run = run;
    runs.set(runId, run);
    writeCard(botId, run);
    const ms = () => Date.now() - startedAt;
    const mark = (value: VerifyDocMark) => run.recording.add(chunk(2, value));
    mark({ ms: 0, kind: "doc-text", lines: doc.text.split("\n").map(redactSecretsInText), pageStarts: doc.pages.flatMap((page, i) => i && page === doc.pages[i - 1] ? [] : [i]) });

    let dirty = true, savedAt = startedAt, timedOut = false, compared = true, next = 0, done = 0;
    const pulse = setInterval(() => {
      const now = Date.now();
      if (now - live.beat! >= BEAT_MS) { live.beat = now; dirty = true; }
      if (now - savedAt >= SAVE_MS) { savedAt = now; writeCard(botId, run); }
      if (dirty) { dirty = false; patchCard(run, { live: true }); }
    }, PULSE_MS);
    const deadline = setTimeout(() => { timedOut = true; run.aborter.abort(); }, CHECK_MS);
    pulse.unref?.();
    deadline.unref?.();
    const cache = caches.get(file) ?? new Map<string, Parsed>();
    remember(caches, file, cache, CACHED_FILES);
    const numbering = numberingHits(doc), found = new Map<string, VerifyDocFinding>(), near = new Map<string, VerifyDocFinding[]>(), names: string[] = [], dates: string[] = [], failed: DocChunk[] = [], keys = new Set<string>();
    const add = (hit: DocHit) => {
      const row = findingAt(doc, hit), key = `${findingKey(row)}\n${row.line}`, spot = `${row.line}\n${row.kind}`;
      // One slip quoted short by one check and long by another is one finding.
      if (near.get(spot)?.some(other => other.quote.includes(row.quote) || row.quote.includes(other.quote))) return;
      near.set(spot, near.get(spot) ?? []).get(spot)!.push(row);
      found.set(key, row);
      live.by![row.kind] = (live.by![row.kind] ?? 0) + 1;
      mark({ ms: ms(), kind: "doc-finding", finding: { ...row, quote: redactSecretsInText(row.quote), fix: redactSecretsInText(row.fix), ...(row.note ? { note: redactSecretsInText(row.note) } : {}) } });
      dirty = true;
    };
    const lost = (part: DocChunk | null, error: unknown) => {
      if (signal.aborted && !timedOut) return;
      if (part) failed.push(part);
      deps.log(`Live Verify: part of ${threadId} not checked: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
    };
    const worker = async () => {
      while (next < parts.length && !signal.aborted) {
        const part = parts[next++]!, body = doc.text.slice(part.start, part.end), key = sha256(body);
        const from = lineIndex(doc, part.start), to = lineIndex(doc, Math.max(part.start, part.end - 1));
        keys.add(key);
        live.page = doc.pages[from];
        dirty = true;
        mark({ ms: ms(), kind: "doc-chunk", from: from + 1, to: to + 1, state: "start" });
        let parsed = cache.get(key);
        if (!parsed) {
          try {
            const reply = parseChunkReply(await generate(chunkPrompt(doc, part, file), { ephemeral: true, lean: true, timeoutMs: CALL_MS, signal }), doc, part);
            if (!reply.ok) throw new Error("the reply was not the JSON asked for");
            parsed = { hits: reply.hits.map(hit => ({ ...hit, at: hit.at - part.start })), names: reply.names, dates: reply.dates };
            cache.set(key, parsed);
          } catch (error) {
            if (signal.aborted && !timedOut) return;
            lost(part, error);
          }
        }
        for (const hit of parsed?.hits ?? []) add({ ...hit, at: hit.at + part.start });
        names.push(...parsed?.names ?? []);
        dates.push(...parsed?.dates ?? []);
        for (const hit of numbering) if (hit.at >= part.start && hit.at < part.end) add(hit);
        live.chunks = [++done, parts.length];
        mark({ ms: ms(), kind: "doc-chunk", from: from + 1, to: to + 1, state: "done" });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(AT_ONCE, parts.length) }, worker));
      // A one-chunk document was compared whole by its chunk call; only the slips found without the model need a look.
      const many = parts.length > 1, clashes = signal.aborted ? [] : dateClashes(doc, dates), twins = signal.aborted ? [] : nameTwins(doc, names);
      const prompt = signal.aborted ? null : mergePrompt(doc, many ? names : [], many ? dates : [], clashes, twins);
      if (prompt) {
        live.page = undefined;
        dirty = true;
        try {
          const reply = parseMergeReply(await generate(prompt, { ephemeral: true, lean: true, timeoutMs: CALL_MS, signal }), doc);
          if (!reply.ok) throw new Error("the reply was not the JSON asked for");
          // A confirmed slip keeps the direction its counts give, whichever way the model wrote it.
          for (const hit of reply.hits) add([...clashes, ...twins].find(row => row.quote === hit.quote || row.quote === hit.fix && row.fix === hit.quote) ?? hit);
        } catch (error) { compared = false; lost(null, error); }
      }
    } finally {
      clearInterval(pulse);
      clearTimeout(deadline);
    }
    if (slot.run !== run || disposed) {
      run.recording.finish({ status: "blocked", ms: ms(), issues: [], notChecked: [] });
      runs.delete(runId);
      return;
    }
    slot.run = undefined;
    failed.push(...parts.slice(next));
    for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
    const findings = [...found.values()].sort((a, b) => a.line - b.line), status: VerifyCardStatus = failed.length < parts.length ? "completed" : "blocked";
    const pages = failed.sort((a, b) => a.start - b.start).map(part => {
      const from = doc.pages[lineIndex(doc, part.start)]!, to = doc.pages[lineIndex(doc, Math.max(part.start, part.end - 1))]!;
      return from === to ? `${from}` : `${from}-${to}`;
    });
    const key = `${threadId}\n${file}`, before = checked.get(key), now = new Set(findings.map(findingKey)), slips = new Set(findings.map(slipKey));
    const whole = status === "completed" && !failed.length && compared;
    // The checker can miss a slip the bot left; only a handed spot gone from the document counts as fixed.
    const text = flat(doc.text), unflagged = fx ? [...fx.handed].filter(([slip]) => !slips.has(slip)).map(([, handed]) => handed) : [];
    const gone = unflagged.filter(handed => !handed.near.some(spot => text.includes(spot))).map(({ row }) => row);
    const shown = [...findings, ...unflagged.map(({ row }) => row).filter(row => !gone.includes(row))].sort((a, b) => a.line - b.line);
    const fixed = !whole ? 0 : fx ? gone.length : before ? [...before.keys].filter(row => !now.has(row)).length : 0;
    if (whole) remember(checked, key, { sha, keys: now }, KEPT);
    const fresh = status === "completed" && (fx?.rounds ?? 0) < FIX_ROUNDS ? findings.filter(row => !fx?.handed.has(slipKey(row))) : [];
    const { prompt, listed } = fixPrompt(file, fresh);
    // A spot is the quote with a few words on either side: the same words can be right elsewhere, and a fixed neighbor changes only one side.
    const context = (row: VerifyDocFinding) => {
      const start = doc.lineStarts[row.line - 1] ?? 0, at = doc.text.indexOf(row.quote, start), to = at + row.quote.length, end = doc.text.indexOf("\n", to);
      if (at < 0) return [flat(row.quote)];
      const sides = [doc.text.slice(Math.max(start, at - NEAR), to), doc.text.slice(at, Math.min(end < 0 ? doc.text.length : end, to + NEAR))].filter(side => side !== row.quote);
      return (sides.length ? sides : [row.quote]).map(flat);
    };
    if (listed.length) {
      fx ??= { botId, humanId, roots: input.roots, file, sha, rounds: 0, handed: new Map(), listed: [], fixing: false };
      // In a room the bot that wrote the file last fixes it; the rounds stay with the file.
      Object.assign(fx, { botId, roots: input.roots, sha, prompt, listed: listed.map(slipKey), fixing: true });
      fx.rounds++;
      for (const row of listed) fx.handed.set(slipKey(row), { row, near: context(row) });
      remember(budgets, budget, fx, KEPT);
      remember(fixes, threadId, fx, KEPT);
    }
    run.card = {
      ...run.card, status, endedAt: Date.now(), ...(status === "blocked" ? { errorCode: timedOut ? "timeout" : "internal" } : {}), ...(pages.length ? { notChecked: pages } : {}), ...(fixed ? { fixed } : {}),
      doc: {
        ...live, page: undefined, beat: undefined, findings: shown.slice(0, VERIFY_DOC_FINDINGS), findingTotal: shown.length, ...(compared ? {} : { uncompared: true }),
        ...(listed.length ? { fixing: true } : {}), ...(fixed && fx ? { fixedFindings: gone.slice(0, VERIFY_DOC_FINDINGS) } : {}),
      },
    };
    writeCard(botId, run);
    if (fx) fx.messageId = run.messageId;
    if (listed.length) hand(threadId, fx!);
    run.recording.finish({ status, ms: ms(), issues: [], notChecked: pages });
    run.saved = run.recording.save(VERIFY_REPLAYS_DIR, threadId, run.messageId!).then(kept => {
      const stored = store.messagesFor(threadId).find(message => message.id === run.messageId);
      if (stored?.verify?.runId === runId) store.patchMessage(threadId, run.messageId!, { verify: { ...run.card, replay: kept.get(`${threadId}/${run.messageId}`) ?? [] } });
    }).catch(() => {}).finally(() => { runs.delete(runId); });
  }

  const fire = (threadId: string) => {
    const slot = slots.get(threadId);
    if (!slot?.input || disposed) return;
    slot.timer = undefined;
    const input = slot.input, token = slot.token;
    if (deps.busy(input.botId, threadId)) {
      slot.timer = setTimeout(fire, quietMs, threadId);
      return;
    }
    slot.input = undefined;
    if (waiting >= WAITING) { deps.log(`Live Verify: skipped ${threadId}, too many document checks waiting`); return dropOrphan(slot, threadId); }
    waiting++;
    chain = chain.then(() => { waiting--; return slot.token === token ? check(slot, input, token) : undefined; }).catch(() => {}).finally(() => {
      if (slots.get(threadId) === slot && slot.token === token && !slot.run && !slot.timer) slots.delete(threadId);
    });
  };

  /** One check per thread, `quietMs` after the last call; a newer call replaces a running check on its card. */
  function schedule(input: DocStart) {
    if (disposed || !input.roots[0]) return;
    if (fixes.get(input.threadId)?.timer) { giveBack(input.threadId); unfix(input.threadId); fixes.delete(input.threadId); }
    const slot = slots.get(input.threadId) ?? { token: {} };
    slots.set(input.threadId, slot);
    slot.input = slot.input?.botId === input.botId ? { ...input, paths: [...new Set([...slot.input.paths, ...input.paths])] } : input;
    slot.token = {};
    if (slot.run) {
      slot.orphan = slot.run.messageId;
      slot.run.aborter.abort();
      slot.run = undefined;
    }
    clearTimeout(slot.timer);
    slot.timer = setTimeout(fire, quietMs, input.threadId);
  }

  return {
    schedule,
    run: (runId: string) => runs.get(runId),
    /** The token a starting turn carries when its prompt is the bot's pending fix; from here its round is spent. */
    fixTurn(botId: string, threadId: string, text: string) {
      const fx = fixes.get(threadId);
      if (!fx?.token || fx.botId !== botId || !text.includes(fx.prompt!)) return undefined;
      fx.listed = [];
      return fx.token;
    },
    /** Any turn that ended; the fix turn ending rechecks its file. */
    ended(turn: { threadId: string; docFix?: string }) {
      const fx = fixes.get(turn.threadId);
      if (!fx?.token || turn.docFix !== fx.token) return;
      fx.token = undefined;
      schedule({ botId: fx.botId, threadId: turn.threadId, roots: fx.roots, paths: [fx.file], humanId: fx.humanId });
    },
    dispose() {
      disposed = true;
      for (const fx of fixes.values()) clearTimeout(fx.timer);
      for (const slot of slots.values()) { clearTimeout(slot.timer); slot.run?.aborter.abort(); }
      slots.clear();
    },
  };
}
