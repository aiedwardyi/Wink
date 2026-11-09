import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { chunk } from "../electron/verify-replay.mjs";
import type { VerifyCardData, VerifyCardStatus } from "../shared/live-verify.ts";
import { VERIFY_DOC_FINDINGS, type VerifyDocFinding, type VerifyDocMark } from "../shared/verify-doc.ts";
import type { ProviderInstance } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message, Store } from "./store.ts";
import { chunkDoc, chunkPrompt, dateClashes, DOC_EXTS, docText, findingAt, lineIndex, mergePrompt, nameTwins, numberingHits, parseChunkReply, parseMergeReply, readDoc, type DocChunk, type DocHit, type DocText } from "./verify-doc-text.ts";
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
// Files a bot keeps for itself or a codebase, not documents written for a person.
const DEV = /^(?:readme|changelog|changes|contributing|licen[cs]e|copying|code_of_conduct|security|notice|authors|claude|agents|gemini|memory|skill)(?:\.[a-z]+)?$|^requirements.*\.txt$|^(?:robots|cmakelists)\.txt$/i;
const PROJECT = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", ".git"];

export interface DocStart { botId: string; threadId: string; roots: string[]; paths: string[] }
export interface VerifyDocDeps {
  store: Pick<Store, "bot" | "conversationForBot" | "appendMessage" | "patchMessage" | "messagesFor">;
  instanceFor: (botId: string, threadId: string) => Pick<ProviderInstance, "generateText"> | null | undefined;
  /** the bot has a turn going */
  busy: (botId: string, threadId: string) => boolean;
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const findingKey = (row: VerifyDocFinding) => `${row.kind}\n${row.quote}\n${row.fix}`;
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
  const checked = new Map<string, { sha: string; keys: Set<string> }>(), caches = new Map<string, Map<string, Parsed>>();
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
    if (!picked || !engine?.generateText || checked.get(`${threadId}\n${picked.file}`)?.sha === picked.sha) return dropOrphan(slot, threadId);
    const { file, site, doc, sha, cut } = picked, generate = engine.generateText.bind(engine);
    const parts = chunkDoc(doc), startedAt = Date.now(), runId = randomUUID();
    const run: Run = {
      runId, threadId, messageId: slot.orphan, aborter: new AbortController(),
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
    const numbering = numberingHits(doc), found = new Map<string, VerifyDocFinding>(), names: string[] = [], dates: string[] = [], failed: DocChunk[] = [], keys = new Set<string>();
    const add = (hit: DocHit) => {
      const row = findingAt(doc, hit), key = `${findingKey(row)}\n${row.line}`;
      // One slip quoted short by one check and long by another is one finding.
      if ([...found.values()].some(other => other.line === row.line && other.kind === row.kind && (other.quote.includes(row.quote) || row.quote.includes(other.quote)))) return;
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
      if (!signal.aborted) for (const hit of [...dateClashes(doc, dates), ...nameTwins(doc, names)]) add(hit);
      const prompt = parts.length > 1 && !signal.aborted ? mergePrompt(doc, names, dates) : null;
      if (prompt) {
        live.page = undefined;
        dirty = true;
        try { for (const hit of parseMergeReply(await generate(prompt, { ephemeral: true, lean: true, timeoutMs: CALL_MS, signal }), doc)) add(hit); }
        catch (error) { compared = false; lost(null, error); }
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
    const key = `${threadId}\n${file}`, before = checked.get(key), now = new Set(findings.map(findingKey));
    const fixed = status === "completed" && !failed.length && compared && before ? [...before.keys].filter(row => !now.has(row)).length : 0;
    if (status === "completed" && !failed.length && compared) remember(checked, key, { sha, keys: now }, KEPT);
    run.card = {
      ...run.card, status, endedAt: Date.now(), ...(status === "blocked" ? { errorCode: timedOut ? "timeout" : "internal" } : {}), ...(pages.length ? { notChecked: pages } : {}), ...(fixed ? { fixed } : {}),
      doc: { ...live, page: undefined, beat: undefined, findings: findings.slice(0, VERIFY_DOC_FINDINGS), findingTotal: findings.length },
    };
    writeCard(botId, run);
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

  return {
    /** One check per thread, `quietMs` after the last call; a newer call replaces a running check on its card. */
    schedule(input: DocStart) {
      if (disposed || !input.roots[0]) return;
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
    },
    run: (runId: string) => runs.get(runId),
    dispose() {
      disposed = true;
      for (const slot of slots.values()) { clearTimeout(slot.timer); slot.run?.aborter.abort(); }
      slots.clear();
    },
  };
}
