import { request } from "node:http";

export interface AppOptions { waitMs?: number; skipPorts?: readonly number[] }

/** A server the turn just started gets this long to listen and serve its first page. */
const WAIT_MS = 20_000;
const RETRY_MS = 400;
const MAX_URLS = 3;
const NAMED = /(?<![\w.@/-])(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))?(?![\w-]|[.:][\w-])([/?#][^\s<>"'`]*)?/gi;

export function appUrls(text: string, skipPorts: readonly number[] = []): string[] {
  const urls = new Set<string>();
  for (const [, scheme, host, port, rest = ""] of text.matchAll(NAMED)) {
    if (scheme?.toLowerCase() === "https://" || !scheme && !port) continue;
    try {
      const url = new URL(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}${port ? `:${port}` : ""}${rest.replace(/[)\].,;:!?*_]+$/, "")}`);
      if (!skipPorts.includes(Number(url.port || 80))) urls.add(url.href);
    } catch {}
  }
  return [...urls].slice(0, MAX_URLS);
}

/** "page" for HTML or a redirect, "other" for any other answer, undefined when nothing answered. */
function ask(url: string, ms: number) {
  return new Promise<"page" | "other" | undefined>(done => {
    const req = request(url, { signal: AbortSignal.timeout(ms), headers: { accept: "text/html" } }, res => {
      const status = res.statusCode ?? 0;
      done(status >= 300 && status < 400 || /html/i.test(String(res.headers["content-type"])) ? "page" : "other");
      res.on("error", () => {});
      res.destroy();
    });
    req.on("error", () => done(undefined));
    req.on("close", () => done(undefined));
    req.end();
  });
}

async function answers(url: string, waitMs: number, stopped: () => boolean): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    const answer = await ask(url, Math.max(1, until - Date.now()));
    if (answer) return answer === "page";
    if (stopped() || Date.now() + RETRY_MS >= until) return false;
    await new Promise(done => setTimeout(done, RETRY_MS));
  }
}

/** The first named loopback URL that serves a page; never starts or probes anything unnamed. */
export async function appEntry(text: string, options: AppOptions = {}): Promise<string | undefined> {
  const urls = appUrls(text, options.skipPorts);
  let over = false;
  const pages = urls.map(url => answers(url, options.waitMs ?? WAIT_MS, () => over));
  try {
    for (const [index, url] of urls.entries()) if (await pages[index]) return url;
  } finally { over = true; }
}
