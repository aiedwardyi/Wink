// web_read's ladder: steps 0-2 run here, step 3 is a hint to the calling bot,
// steps 4-5 run from the agents proxy through ask_bot, step 6 is the honest stop.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

import { markPage, WEB_READ_OWN_TOOL, WEB_READ_SEARCH_ONLY, WEB_READ_STOP, type WebReadReader, type WebReadResult } from "../shared/web-read.ts";
import { json, readBody } from "./http-helpers.ts";
import { nodeTransport, refusedTarget, type Hop, type Transport } from "./web-read-net.ts";
import { parseRobots, robotsAllows, type RobotsRule } from "./web-read-robots.ts";
import { bodyText, capText, challengeReason, htmlToText, isPlaceholder, pdfToText } from "./web-read-text.ts";

export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/pdf;q=0.8,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, deflate, br",
};
export const CACHE_MS = 15 * 60_000;
export const SITE_BUDGET = 3;
export const SITE_WINDOW_MS = 60_000;
export const PAUSE_429_MS = 10 * 60_000;
const HOP_MS = 10_000;
/** One deadline for all of Wink's own requests in a read: robots.txt, YouTube, the page and every redirect. */
export const READ_DEADLINE_MS = 30_000;
// RFC 9309: a cached robots.txt is good for a day.
const ROBOTS_CACHE_MS = 24 * 60 * 60_000;
export const ROBOTS_ROWS = 300;
const MAX_HOPS = 5;
const CACHE_ROWS = 300;
// Provider-side readers that got through where Wink's own fetch could not (RESULT.md: Grok 6/6, Codex 5/6).
export const READER_ENGINES: readonly string[] = ["grokAgent", "codex"];

export function siteKey(hostname: string): string {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (isIP(host)) return host;
  const labels = host.split(".");
  const second = labels.at(-2) ?? "";
  const keep = labels.length > 2 && (labels.at(-1) ?? "").length === 2 && /^(co|com|org|net|ac|gov|edu|or|ne|go)$/.test(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

const isLinkedIn = (hostname: string) => siteKey(hostname) === "linkedin.com" || siteKey(hostname) === "lnkd.in";

/** Per-site politeness: at most SITE_BUDGET requests a minute, and a 429 pauses the site for 10 minutes. */
export class SiteGate {
  private hits = new Map<string, number[]>();
  private paused = new Map<string, number>();
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  admit(hostname: string): string | null {
    const site = siteKey(hostname);
    const now = this.now();
    const until = this.paused.get(site) ?? 0;
    if (until > now) return `${site} answered 429 (too many requests), so Wink leaves it alone for ${Math.ceil((until - now) / 60_000)} more min`;
    const recent = (this.hits.get(site) ?? []).filter((at) => now - at < SITE_WINDOW_MS);
    if (recent.length >= SITE_BUDGET) {
      this.hits.set(site, recent);
      return `polite limit reached (${SITE_BUDGET} requests a minute to ${site})`;
    }
    recent.push(now);
    this.hits.set(site, recent);
    return null;
  }

  pause(hostname: string): void {
    this.paused.set(siteKey(hostname), this.now() + PAUSE_429_MS);
  }
}

type Step = { ok: boolean; route: string; text: string; tried: string[]; final?: boolean; keep?: boolean; searchOnly?: boolean };
type Got = { hop: Hop; url: URL } | { error: string; final?: boolean; gated?: boolean; searchOnly?: boolean };
type GetOpts = { admitted?: Set<string>; body?: Buffer; deadline?: AbortSignal; robots?: boolean };

export function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  return url.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{6,})/)?.[1] ?? null;
}

function captionText(body: string): string {
  try {
    const events = (JSON.parse(body) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> }).events ?? [];
    return events.map((event) => (event.segs ?? []).map((seg) => seg.utf8 ?? "").join("")).join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((match) => match[1]!.replace(/&amp;#39;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"')).join(" ").replace(/\s+/g, " ").trim();
  }
}

// YouTube's player API, asked as its Android app (the web client gets no playable answer without a browser token).
const YT_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const YT_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en" };

type CaptionTrack = { baseUrl?: string; languageCode?: string; kind?: string };
type PlayerResponse = { videoDetails?: { title?: string; author?: string; shortDescription?: string }; captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } } };

export interface WebReaderDeps {
  transport?: Transport;
  now?: () => number;
  /** Defaults to READ_DEADLINE_MS. */
  deadlineMs?: number;
  /** Bots this caller could borrow for step 4. */
  readers?: () => Array<WebReadReader & { busy: boolean }>;
}

export function createWebReader(deps: WebReaderDeps = {}) {
  const transport = deps.transport ?? nodeTransport;
  const now = deps.now ?? Date.now;
  const gate = new SiteGate(now);
  const cache = new Map<string, { step: Step; at: number }>();
  const inflight = new Map<string, Promise<Step>>();
  const robotsCache = new Map<string, { rules: RobotsRule[]; at: number }>();
  const deadlineMs = deps.deadlineMs ?? READ_DEADLINE_MS;
  const overDeadline = `stopped: one read gets ${deadlineMs / 1000} s in all`;

  /** GET with redirects checked hop by hop; with `body`, one POST that is never redirected. */
  async function get(start: URL, label: string, opts: GetOpts = {}): Promise<Got> {
    let current = start;
    const seen = new Set<string>();
    // One read spends one unit of a site's budget; its redirects within that site are free.
    const admitted = opts.admitted ?? new Set<string>();
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const refused = refusedTarget(current);
      if (refused) return { error: `redirected to ${refused}, not followed`, final: true };
      if (isLinkedIn(current.hostname)) return { error: "redirected to linkedin.com, which Wink never fetches (search results only)", searchOnly: true };
      if (opts.deadline?.aborted) return { error: overDeadline };
      if (seen.has(current.href)) return { error: "redirect loop" };
      seen.add(current.href);
      if (!admitted.has(siteKey(current.hostname))) {
        const held = gate.admit(current.hostname);
        if (held) return { error: held, gated: true };
        admitted.add(siteKey(current.hostname));
      }
      if (opts.robots) {
        const closed = await robotsVerdict(current, admitted, opts.deadline);
        if (closed) return { error: closed };
      }
      const signal = opts.deadline ? AbortSignal.any([AbortSignal.timeout(HOP_MS), opts.deadline]) : AbortSignal.timeout(HOP_MS);
      let got: Hop;
      try {
        got = opts.body
          ? await transport(current, { ...BROWSER_HEADERS, "content-type": "application/json" }, signal, opts.body)
          : await transport(current, { ...BROWSER_HEADERS }, signal);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "EPRIVATE") return { error: "the site name points to a private address, not read", final: true };
        if (opts.deadline?.aborted) return { error: overDeadline };
        if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") return { error: `no answer in ${HOP_MS / 1000} s` };
        return { error: `network error (${code ?? (error as Error).message})` };
      }
      const location = got.status >= 300 && got.status < 400 ? got.headers.location : undefined;
      if (!location) return { hop: got, url: current };
      if (opts.body) return { error: `redirected (HTTP ${got.status}), not followed` };
      try {
        current = new URL(location, current);
      } catch {
        return { error: `${label}: bad redirect`, final: true };
      }
    }
    return { error: `more than ${MAX_HOPS} redirects` };
  }

  /** Why robots.txt closes this path to Wink, or null. One fetch per origin, cached a day; a 5xx or unreachable file counts as closed (RFC 9309). */
  async function robotsVerdict(url: URL, admitted: Set<string>, deadline?: AbortSignal): Promise<string | null> {
    const label = "robots.txt";
    let hit = robotsCache.get(url.origin);
    if (!hit || now() - hit.at >= ROBOTS_CACHE_MS) {
      const got = await get(new URL("/robots.txt", url.origin), label, { admitted, deadline });
      if ("error" in got) return `${label}: ${got.error}${got.gated ? "" : ", so the site counts as closed to automated reads"}`;
      const { status } = got.hop;
      if (status === 429) {
        gate.pause(got.url.hostname);
        return `${label}: HTTP 429, ${siteKey(got.url.hostname)} paused for 10 min, no retry`;
      }
      if (status >= 500) return `${label}: HTTP ${status}, so the site counts as closed to automated reads`;
      // A missing or refused robots.txt (4xx) sets no rules.
      hit = { rules: status >= 200 && status < 300 ? parseRobots(got.hop.body.toString("utf8")) : [], at: now() };
      robotsCache.delete(url.origin);
      robotsCache.set(url.origin, hit);
      if (robotsCache.size > ROBOTS_ROWS) robotsCache.delete(robotsCache.keys().next().value!);
    }
    return robotsAllows(hit.rules, url.pathname + url.search) ? null : `${label}: ${url.hostname} asks automated readers not to open ${url.pathname}`;
  }

  /** Caption text for a player response, read from the caption link it carries; `stop` means the next path would not help. */
  async function captions(player: PlayerResponse, label: string, admitted: Set<string>, deadline: AbortSignal): Promise<Step & { meta?: string; stop?: boolean }> {
    const details = player.videoDetails ?? {};
    const head = [details.title ? `# ${details.title}` : "", details.author ? `Channel: ${details.author}` : ""].filter(Boolean).join("\n");
    const meta = [head, details.shortDescription ? `Description:\n${details.shortDescription}` : ""].filter(Boolean).join("\n\n");
    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const track = tracks.find((t) => t.languageCode?.startsWith("en") && !t.kind) ?? tracks.find((t) => t.languageCode?.startsWith("en")) ?? tracks[0];
    if (!track?.baseUrl) return { ok: false, route: "youtube", text: "", meta, stop: Boolean(details.title), tried: [`${label}: ${details.title ? "this video has no captions" : "no video data"}`] };
    let captionUrl: URL;
    try {
      captionUrl = new URL(track.baseUrl, "https://www.youtube.com");
    } catch {
      return { ok: false, route: "youtube", text: "", meta, tried: [`${label}: bad caption link`] };
    }
    if (siteKey(captionUrl.hostname) !== "youtube.com") return { ok: false, route: "youtube", text: "", meta, tried: [`${label}: caption link points off youtube.com, not followed`] };
    captionUrl.searchParams.set("fmt", "json3");
    const caption = await get(captionUrl, label, { admitted, deadline });
    if ("error" in caption) return { ok: false, route: "youtube", text: "", meta, stop: caption.gated || caption.final, tried: [`${label}: ${caption.error}`] };
    if (caption.hop.status === 429) {
      gate.pause(caption.url.hostname);
      return { ok: false, route: "youtube", text: "", meta, stop: true, tried: [`${label}: HTTP 429, youtube.com paused for 10 min, no retry`] };
    }
    const transcript = caption.hop.status === 200 ? captionText(caption.hop.body.toString("utf8")) : "";
    if (!transcript) return { ok: false, route: "youtube", text: "", meta, keep: true, tried: [`${label}: YouTube sent no caption text (HTTP ${caption.hop.status}; it can require a token plain reads don't have)`] };
    return { ok: true, route: "youtube-captions", text: `${head}\n\nTranscript (${track.languageCode ?? "?"}${track.kind === "asr" ? ", auto-generated" : ""}):\n${transcript}`, keep: true, tried: [`${label}: ok, ${transcript.length.toLocaleString("en-US")} chars`] };
  }

  async function youtube(id: string, deadline: AbortSignal): Promise<Step & { meta?: string }> {
    const label = "step 1 YouTube captions";
    // However many of these requests run, one read spends one unit of youtube.com's budget.
    const admitted = new Set<string>();
    const watch = new URL(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=en`);
    // robots.txt is checked for the video's own page; the player API and caption links under it are the reads Edward approved (11-22).
    const held = gate.admit(watch.hostname);
    if (held) return { ok: false, route: "youtube", text: "", tried: [`${label}: ${held}`] };
    admitted.add(siteKey(watch.hostname));
    const closed = await robotsVerdict(watch, admitted, deadline);
    if (closed) return { ok: false, route: "youtube", text: "", tried: [`${label}: ${closed}`] };
    const paused = (url: URL) => {
      gate.pause(url.hostname);
      return { ok: false, route: "youtube", text: "", tried: [`${label}: HTTP 429, youtube.com paused for 10 min, no retry`] };
    };

    // First YouTube's own player API: its caption links work without the token the watch page's links now need.
    const api = await get(new URL(`${YT_PLAYER_URL}?prettyPrint=false`), `${label} (player API)`, { admitted, deadline, body: Buffer.from(JSON.stringify({ context: { client: YT_CLIENT }, videoId: id })) });
    const tried: string[] = [];
    let fromApi: Step & { meta?: string; stop?: boolean } = { ok: false, route: "youtube", text: "", tried: [] };
    if ("error" in api) {
      if (api.gated || api.final) return { ok: false, route: "youtube", text: "", tried: [`${label}: ${api.error}`] };
      tried.push(`${label} (player API): ${api.error}`);
    } else if (api.hop.status === 429) {
      return paused(api.url);
    } else if (api.hop.status !== 200) {
      tried.push(`${label} (player API): HTTP ${api.hop.status}`);
    } else {
      let player: PlayerResponse = {};
      try {
        player = JSON.parse(api.hop.body.toString("utf8")) as PlayerResponse;
      } catch {}
      fromApi = await captions(player, `${label} (player API)`, admitted, deadline);
      if (fromApi.ok || fromApi.stop) return fromApi;
      tried.push(...fromApi.tried);
    }

    // Fallback, GET only: the watch page and the caption link it carries.
    const page = await get(watch, `${label} (watch page)`, { admitted, deadline });
    if ("error" in page) return { ok: false, route: "youtube", text: "", meta: fromApi.meta, tried: [...tried, `${label} (watch page): ${page.error}`] };
    if (page.hop.status === 429) {
      const stop = paused(page.url);
      return { ...stop, meta: fromApi.meta, tried: [...tried, ...stop.tried] };
    }
    const html = page.hop.body.toString("utf8");
    let player: PlayerResponse = {};
    try {
      player = JSON.parse(html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script)/s)?.[1] ?? "{}") as PlayerResponse;
    } catch {}
    const fromPage = await captions(player, `${label} (watch page)`, admitted, deadline);
    return { ...fromPage, meta: fromPage.meta || fromApi.meta, tried: [...tried, ...fromPage.tried] };
  }

  async function fetchPage(url: URL, deadline: AbortSignal): Promise<Step> {
    const label = "step 2 fetch";
    const got = await get(url, label, { robots: true, deadline });
    if ("error" in got) return { ok: false, route: "fetch", text: "", tried: [`${label}: ${got.error}`], final: got.final, searchOnly: got.searchOnly };
    const { hop, url: landed } = got;
    const type = (hop.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const sniff = hop.body.subarray(0, 512).toString("latin1");
    const html = type.includes("html") || (!type && /^\s*<(!doctype|html|head|body)/i.test(sniff));
    // The server writes Content-Type, so only a plain media type is ever shown to the bot.
    const shownType = /^[a-z0-9][a-z0-9.+-]{0,39}\/[a-z0-9][a-z0-9.+-]{0,79}$/.test(type) ? type : "unknown type";
    const tried = (note: string) => [`${label}: ${note}${hop.truncated ? " (page over 2 MB, read the first 2 MB)" : ""}`];
    if (hop.status === 429) {
      gate.pause(landed.hostname);
      return { ok: false, route: "fetch", text: "", tried: tried(`HTTP 429, ${siteKey(landed.hostname)} paused for 10 min, no retry`) };
    }
    if (hop.status === 404 || hop.status === 410) return { ok: false, route: "fetch", text: `The page does not exist (HTTP ${hop.status}).`, tried: tried(`HTTP ${hop.status}, page not found`), final: true, keep: true };
    const body = bodyText(hop.body, hop.headers["content-type"]);
    const page = html ? htmlToText(body) : null;
    const challenge = html && page ? challengeReason(body, landed, page.text, url) : null;
    if (challenge) return { ok: false, route: "fetch", text: "", tried: tried(`${challenge} (HTTP ${hop.status})`), keep: true };
    if (hop.status < 200 || hop.status >= 300) return { ok: false, route: "fetch", text: "", tried: tried(`HTTP ${hop.status}`), keep: hop.status < 500 };
    if (page) {
      const heading = page.title ? `# ${page.title}\n\n` : "";
      // "Loading…" alone is what the page shows until its scripts run, not its text.
      const text = isPlaceholder(page.text) ? "" : page.text;
      // A page that runs no script can't build more text, so short text is the whole page.
      const scripted = /<script\b(?![^>]*\btype\s*=\s*["']?application\/(?:ld\+)?json)/i.test(body);
      if (text.length >= 200 || (text && !scripted)) return { ok: true, route: "fetch", text: heading + text, tried: tried(`ok, ${text.length.toLocaleString("en-US")} chars`), keep: true };
      // Whatever was found is kept, labeled partial (a title and summary may be the site's, not this page's), and the ladder goes on.
      const found = [page.title && `# ${page.title}`, text, page.description].filter(Boolean).join("\n\n");
      if (found) {
        const [what, note] = text
          ? ["what the page shows before its scripts run was", `${text.length.toLocaleString("en-US")} chars before scripts run`]
          : page.description ? ["the page's title and summary were", "title and summary only"] : ["the page's title was", "title only"];
        return { ok: false, route: "fetch:meta", text: `[Partial: only ${what} readable.]\n\n${markPage(found)}`, tried: tried(note), keep: true };
      }
      return { ok: false, route: "fetch", text: "", tried: tried(page.text ? "only a loading message (no readable text without a browser)" : "empty JavaScript page (no readable text without a browser)"), keep: true };
    }
    if (type === "application/pdf" || sniff.startsWith("%PDF")) {
      const text = await pdfToText(hop.body);
      return text
        ? { ok: true, route: "fetch:pdf", text, tried: tried(`PDF, ${text.length.toLocaleString("en-US")} chars`), keep: true }
        : { ok: false, route: "fetch:pdf", text: "", tried: tried("PDF with no extractable text (scanned or unusual fonts)"), keep: true };
    }
    if (/^text\/|json|xml|javascript|csv|yaml|markdown/.test(type)) {
      return { ok: true, route: "fetch", text: body, tried: tried(`ok, ${shownType}`), keep: true };
    }
    return { ok: false, route: "fetch", text: `Not a text page (${shownType}).`, tried: tried(`not a text page (${shownType}, ${Math.round(hop.body.length / 1024)} KB)`), final: true, keep: true };
  }

  async function ladder(url: URL): Promise<Step> {
    const deadline = AbortSignal.timeout(deadlineMs);
    const id = youtubeId(url);
    if (!id) return fetchPage(url, deadline);
    const video = await youtube(id, deadline);
    if (video.ok) return video;
    const partial = video.meta ? `[Partial: no transcript, only the video's title and description.]\n\n${markPage(video.meta)}` : "";
    return { ok: false, route: "youtube", text: partial, keep: video.keep, tried: [...video.tried, "step 2 fetch: skipped, the YouTube page itself has no transcript"] };
  }

  function pickReader(callerBotId: string): WebReadReader | undefined {
    const rank = (engine: string) => READER_ENGINES.indexOf(engine);
    const reader = (deps.readers?.() ?? [])
      .filter((bot) => bot.botId !== callerBotId && !bot.busy && rank(bot.engine) >= 0)
      .sort((a, b) => rank(a.engine) - rank(b.engine))[0];
    return reader ? { botId: reader.botId, name: reader.name, engine: reader.engine } : undefined;
  }

  /** `guest`: another person started this turn, so no step 4 and no cache writes. */
  async function read(raw: string, opts: { ownToolFailed?: boolean; callerBotId?: string; guest?: boolean } = {}): Promise<WebReadResult> {
    const trimmed = raw.trim();
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
      return { status: "blocked", url: trimmed, route: "refused", text: "That is not a web address.", tried: ["refused: not a URL"] };
    }
    const refused = refusedTarget(url);
    if (refused) return { status: "blocked", url: url.href, route: "refused", text: `Not read: ${refused}. web_read reads public http(s) pages only.`, tried: [`refused: ${refused}`] };
    url.hash = "";
    const key = url.href;
    const linkedIn = isLinkedIn(url.hostname);
    let step: Step;
    if (linkedIn) {
      step = { ok: false, route: "search-only", text: "", tried: ["steps 1-2: skipped, Wink never fetches linkedin.com pages (search results only)"] };
    } else {
      const hit = cache.get(key);
      if (hit && now() - hit.at < CACHE_MS) {
        step = { ...hit.step, tried: [`step 0 cache: read ${Math.round((now() - hit.at) / 60_000)} min ago`, ...hit.step.tried] };
      } else {
        let pending = inflight.get(key);
        if (!pending) {
          pending = ladder(url).finally(() => inflight.delete(key));
          inflight.set(key, pending);
        }
        step = await pending;
        if (step.keep && !opts.guest) {
          cache.set(key, { step, at: now() });
          if (cache.size > CACHE_ROWS) cache.delete(cache.keys().next().value!);
        }
      }
    }
    // A redirect that lands on a never-fetch host makes the read search-only too.
    const searchOnly = linkedIn || step.searchOnly === true;
    if (step.ok) return { status: "ok", url: key, route: step.route, text: capText(markPage(step.text)), tried: step.tried };
    const tried = [...step.tried];
    const text = capText(step.text);
    if (step.final) return { status: "blocked", url: key, route: step.route, text, tried };
    if (!opts.ownToolFailed) {
      tried.push("step 3 your own web tool: not tried yet");
      return { status: "blocked", url: key, route: step.route, text, tried, next: searchOnly ? WEB_READ_SEARCH_ONLY : WEB_READ_OWN_TOOL, ...(searchOnly ? { searchOnly } : {}) };
    }
    tried.push("step 3 your own web tool: failed");
    // A turn another person started in a room may not spend the host's other bots.
    const reader = opts.guest ? undefined : pickReader(opts.callerBotId ?? "");
    if (reader) return { status: "blocked", url: key, route: step.route, text, tried, reader, ...(searchOnly ? { searchOnly } : {}) };
    tried.push(opts.guest ? "step 4 cross-engine reader: skipped, another person started this turn" : "step 4 cross-engine reader: no free Codex or Grok bot to ask");
    return { status: "blocked", url: key, route: "stop", text: text ? `${text}\n\n${WEB_READ_STOP}` : WEB_READ_STOP, tried };
  }

  /** Step 4's answer, so the same URL is not read twice within the cache window. */
  function remember(raw: string, route: string, text: string): void {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (refusedTarget(url) || isLinkedIn(url.hostname) || !text.trim()) return;
    url.hash = "";
    cache.set(url.href, { step: { ok: true, route, text, tried: [`${route}: read earlier`], keep: true }, at: now() });
  }

  return { read, remember, gate };
}

export type WebReader = ReturnType<typeof createWebReader>;

/** Reads one room's guest turns may start per minute, all bots in the room together. */
export const GUEST_READS_PER_MINUTE = 6;
const GUEST_ROOMS = 300;

/**
 * The route the agents proxy calls. A guest turn (another person's text drives a room turn) is decided here from the
 * caller's own turn, not from the request body: it gets the same SSRF and site budgets, no step 4, no cache writes,
 * and a per-room read budget so a guest can't keep the host's PC fetching and parsing.
 */
export function webReadRoute(
  reader: WebReader,
  caller: (header: string | string[] | undefined) => { botId: string; threadId: string } | undefined,
  guestTurn: (botId: string, threadId: string) => boolean = () => false,
  now: () => number = Date.now,
) {
  const roomReads = new Map<string, number[]>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    const source = caller(req.headers.authorization);
    if (!source) return json(res, 403, { error: "unknown sender" });
    const body = ((await readBody(req)) ?? {}) as { url?: unknown; own_tool_failed?: unknown; no_reader?: unknown; remember?: { route?: unknown; text?: unknown } };
    const url = typeof body.url === "string" ? body.url : "";
    const guest = guestTurn(source.botId, source.threadId);
    if (body.remember && typeof body.remember.text === "string") {
      if (guest) return json(res, 403, { error: "a guest turn can't add pages to the shared cache" });
      reader.remember(url, String(body.remember.route ?? "reader"), body.remember.text);
      return json(res, 200, { ok: true });
    }
    if (guest) {
      const at = now();
      const recent = (roomReads.get(source.threadId) ?? []).filter((t) => at - t < 60_000);
      if (recent.length >= GUEST_READS_PER_MINUTE) {
        const result: WebReadResult = {
          status: "blocked",
          url,
          route: "none",
          text: `This room's guest turns already started ${GUEST_READS_PER_MINUTE} page reads in the last minute; try again in a minute.`,
          tried: [`room budget: ${GUEST_READS_PER_MINUTE} reads a minute for guest turns, used up`],
        };
        return json(res, 200, result);
      }
      recent.push(at);
      roomReads.delete(source.threadId);
      roomReads.set(source.threadId, recent);
      if (roomReads.size > GUEST_ROOMS) roomReads.delete(roomReads.keys().next().value!);
    }
    return json(res, 200, await reader.read(url, { ownToolFailed: body.own_tool_failed === true, callerBotId: source.botId, guest: guest || body.no_reader === true }));
  };
}
