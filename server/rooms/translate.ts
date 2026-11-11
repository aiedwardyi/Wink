import type { IncomingMessage, ServerResponse } from "node:http";

import type { BotAccounts } from "../bot-accounts.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { json, readBody } from "../http-helpers.ts";
import type { Store } from "../store.ts";
import { roomEntry, roomPeople, roomTranslation, saveRoomTranslation } from "./db.ts";
import { joinedEntry, joinedRoom, joinedTranslation, saveJoinedTranslation } from "./joined.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { protectTranslationNames } from "./translation-names.ts";

const ROUTE = /^\/api\/(joined\/)?rooms\/([\w-]{1,64})(?:\/entries\/([\w-]{1,64}))?\/translate$/;
const TIMEOUT_MS = 30_000;
const GEMINI_MODEL = "gemini-3.5-flash-lite";
type TextEngine = Pick<ProviderInstance, "driverKind" | "enabled" | "generateText"> & Partial<Pick<ProviderInstance, "models">>;
type Generator = (prompt: string, signal: AbortSignal) => Promise<string>;

export function translationInstances(registry: Pick<ProviderRegistry, "instances" | "get" | "describeSaved" | "accountBlocked">, accounts: Pick<BotAccounts, "mainAccount">): ProviderInstance[] {
  const saved = registry.describeSaved();
  return registry.instances().filter((instance) => !instance.account && instance.enabled).flatMap((profile) => {
    const main = accounts.mainAccount(profile.instanceId);
    const instance = main === null ? undefined : main ? registry.get(main.id) : profile;
    const snapshot = saved.find((row) => row.instanceId === instance?.instanceId)?.snapshot;
    return instance && !registry.accountBlocked(instance.instanceId) && snapshot?.state === "available" && snapshot.authenticated !== false ? [instance] : [];
  });
}

function codexModel(instance: TextEngine): string | undefined {
  const options = instance.models?.options.filter((option) => !option.custom && !option.id.includes("::")) ?? [];
  return ["nano", "mini", "luna"].map((name) => options.find((option) => option.id.includes(name))?.id).find(Boolean)
    ?? options.find((option) => option.id === instance.models?.default)?.id ?? options[0]?.id;
}

export function translationGenerator(key: string | undefined, instances: readonly TextEngine[], fetchFn: typeof fetch = fetch): Generator | null {
  if (key?.trim()) return async (prompt, signal) => {
    const response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key.trim() },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 4096 } }),
      signal,
    });
    if (!response.ok) throw new Error("translation failed");
    const data = await response.json() as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== "STOP") throw new Error("translation failed");
    return (candidate?.content?.parts ?? []).filter((part) => !part.thought).map((part) => part.text ?? "").join("");
  };
  const enabled = instances.filter((instance) => instance.enabled && instance.generateText && (instance.driverKind !== "codex" || codexModel(instance)));
  const engine = enabled.find((instance) => instance.driverKind === "claudeAgent")
    ?? enabled.find((instance) => instance.driverKind === "codex") ?? enabled[0];
  if (!engine) return null;
  const model = engine.driverKind === "codex" ? codexModel(engine) : undefined;
  return (prompt, signal) => engine.generateText!(prompt, { signal, timeoutMs: TIMEOUT_MS, ephemeral: true, lean: true, ...(model ? { model } : {}) });
}

function promptFor(text: string, lang: "en" | "ko"): string {
  return `Translate the chat message between the <message> tags into ${lang === "ko" ? "Korean" : "English"}. Reply with only the translation. Keep names, @mentions, code, links, numbers, emoji and line breaks as they are. Never translate, transliterate or romanize people's names. Copy each name_ element exactly once with its tags and enclosed name unchanged.\n<message>\n${text}\n</message>`;
}

const pending = new Map<string, Promise<string>>();
const active = new Set<Promise<string>>();

function generateOnce(key: string, generate: Generator, prompt: string, save: (text: string) => void): Promise<string> {
  const earlier = pending.get(key);
  if (earlier) return earlier;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("translation timed out")); }, TIMEOUT_MS);
  });
  const work = (async () => {
    while (active.size >= 2) await Promise.race([timeout, ...[...active].map((call) => call.then(() => {}, () => {}))]);
    controller.signal.throwIfAborted();
    const call = Promise.resolve().then(() => generate(prompt, controller.signal));
    active.add(call);
    try {
      const text = (await call).trim();
      controller.signal.throwIfAborted();
      if (!text) throw new Error("empty translation");
      save(text);
      return text;
    } finally { active.delete(call); }
  })();
  const reply = Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  pending.set(key, reply);
  // A provider ignoring abort still occupies its slot and line until it settles.
  void work.then(() => pending.delete(key), () => pending.delete(key));
  return reply;
}

export async function translateRoute(
  req: IncomingMessage, res: ServerResponse, method: string, path: string,
  deps: { store: Pick<Store, "groups">; instances: readonly TextEngine[] | (() => readonly TextEngine[]); key?: string; hostName?: string; botCaller: boolean },
): Promise<boolean> {
  const route = ROUTE.exec(path);
  if (!route) return false;
  const [, joined, roomId, entryId] = route as unknown as [string, string | undefined, string, string | undefined];
  if (deps.botCaller) { json(res, 403, { error: "forbidden" }); return true; }
  const held = () => joined ? joinedRoom(roomId) !== null
    : deps.store.groups.some((group) => group.hosted?.roomId === roomId && group.memberIds.length === 0) && peopleOnlyRoom(roomId);
  if (!held() || method !== (entryId ? "POST" : "GET")) { json(res, 404, { error: "not found" }); return true; }
  const generate = translationGenerator(deps.key, deps.key?.trim() ? [] : typeof deps.instances === "function" ? deps.instances() : deps.instances);
  if (!entryId) { json(res, 200, { available: generate !== null }); return true; }
  const entry = () => joined ? joinedEntry(roomId, entryId) : roomEntry(roomId, entryId);
  const line = entry();
  const own = joined ? line?.author.kind === "person" && line.author.id === joinedRoom(roomId)?.me.id : line?.author.kind !== "person";
  if (!line?.text || own) { json(res, 404, { error: "not found" }); return true; }
  try {
    const body = await readBody(req);
    const lang = body?.lang;
    if (lang !== "en" && lang !== "ko") { json(res, 400, { error: "bad request" }); return true; }
    if (!held() || entry()?.text !== line.text) { json(res, 404, { error: "not found" }); return true; }
    const room = joined ? joinedRoom(roomId) : null;
    const names = room ? [room.me.name, room.state?.host ?? "", ...(room.state?.people.map((person) => person.name) ?? [])]
      : [deps.hostName ?? "", ...roomPeople(roomId).map((person) => person.name)];
    const protectedNames = protectTranslationNames(line.text, [...names, line.author.name]);
    // Older cached translations did not enforce exact name spelling.
    const cacheLang = protectedNames.hasNames ? `${lang}:names-v1:${protectedNames.cacheKey}` : lang;
    const cached = (joined ? joinedTranslation : roomTranslation)(roomId, entryId, cacheLang);
    if (cached !== undefined) { json(res, 200, { text: cached }); return true; }
    if (!generate) { json(res, 503, { error: "translation unavailable" }); return true; }
    const text = await generateOnce(`${joined ?? "host/"}${roomId}/${entryId}/${cacheLang}`,
      async (prompt, signal) => protectedNames.restore(await generate(prompt, signal)), promptFor(protectedNames.text, lang), (text) => {
        if (!held() || entry()?.text !== line.text) throw Object.assign(new Error("not found"), { status: 404 });
        (joined ? saveJoinedTranslation : saveRoomTranslation)(roomId, entryId, cacheLang, text);
      });
    json(res, 200, { text });
  } catch (error) {
    const status = (error as { status?: number }).status;
    json(res, status === 400 || status === 413 || status === 404 ? status : 502, { error: status === 404 ? "not found" : status === 400 || status === 413 ? "bad request" : "translation failed" });
  }
  return true;
}
