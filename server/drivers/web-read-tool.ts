// The web_read tool inside the agents proxy: the harness runs steps 0-2; step 4
// borrows a Codex or Grok bot through the same ask_bot call a bot makes itself.
import { markPage, WEB_READ_ROUTE, WEB_READ_STOP, WEB_READ_TOOL_NAME, type WebReadResult } from "../../shared/web-read.ts";
import { capText } from "../web-read-text.ts";

type Json = Record<string, unknown>;
type Api = (path: string, init?: RequestInit) => Promise<Json>;
type AskBot = (toBotId: string, message: string) => Promise<Json>;

/** One web_read call, step 4 included, ends within this; Wink's own steps get READ_DEADLINE_MS (30 s) of it. */
export const WEB_READ_CALL_MS = 120_000;

export const WEB_READ_TOOL = {
  name: WEB_READ_TOOL_NAME,
  description: "Read a public web page, PDF, post or video as text. Follow next when present.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" }, own_tool_failed: { type: "boolean" } },
    required: ["url"],
    additionalProperties: false,
  },
};

export function readerPrompt(url: string, searchOnly = false): string {
  const rules = "Use only your web tools: no files, shell, sign-ins or other tools, and no reader or mirror sites (r.jina.ai, fxtwitter, transcript sites).";
  return searchOnly
    ? `[Wink web_read] A teammate needs what web search shows about this page: ${url}\nSearch only; never open linkedin.com pages. ${rules}\nReply "SEARCH:" and then the useful snippets with their links, or "BLOCKED:" and one line on why.`
    : `[Wink web_read] A teammate could not open this page; read it for them: ${url}\n${rules}\nReply with only the page's main text, up to about 6,000 characters, no commentary. If you can't open it but web search shows it, reply "SEARCH:" and then the useful snippets with their links. If neither works, reply "BLOCKED:" and one line on why.`;
}

const shown = (r: Pick<WebReadResult, "status" | "route" | "tried" | "text" | "next">) =>
  JSON.stringify({ status: r.status, route: r.route, tried: r.tried, ...(r.next ? { next: r.next } : {}), text: r.text });

export async function webRead(args: Json, api: Api, askBot: AskBot, guestTurn = false, callMs = WEB_READ_CALL_MS): Promise<{ text: string; isError?: boolean }> {
  const started = Date.now();
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return { text: "web_read needs url.", isError: true };
  const r = (await api(WEB_READ_ROUTE, { method: "POST", body: JSON.stringify({ url, own_tool_failed: args.own_tool_failed === true, ...(guestTurn ? { no_reader: true } : {}) }) })) as unknown as WebReadResult;
  if (r.status !== "blocked" || !r.reader || guestTurn) return { text: shown(r) };
  const reader = r.reader;
  const who = `@${reader.name} (${reader.engine})`;
  const tried = [...r.tried];
  let reply: Json;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const left = Math.max(callMs - (Date.now() - started), 0);
  const limit = new Promise<Json>((resolve) => {
    timer = setTimeout(() => resolve({ error: `no reply within web_read's ${Math.round(callMs / 1000)} s limit` }), left);
  });
  try {
    reply = await Promise.race([askBot(reader.botId, readerPrompt(r.url, r.searchOnly)), limit]);
  } catch (error) {
    reply = { error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
  const answer = typeof reply.text === "string" ? reply.text.trim() : "";
  const failed = reply.limit ?? reply.error ?? (reply.busy ? "busy" : reply.taskId ? "still working after the wait limit" : "");
  if (!failed && answer.length > 40 && !/^BLOCKED\b/i.test(answer)) {
    const search = /^SEARCH:/i.test(answer);
    const route = `${search ? "search" : "reader"}:${reader.engine}`;
    const text = search ? `From search results, not the page:\n${answer.replace(/^SEARCH:\s*/i, "")}` : answer;
    if (search) tried.push(`step 4 ${who}: could not open the page`, `step 5 search snippets via ${who}: ok`);
    else tried.push(`step 4 ${who}: ok`);
    await api(WEB_READ_ROUTE, { method: "POST", body: JSON.stringify({ url: r.url, remember: { route, text } }) }).catch(() => undefined);
    return { text: shown({ status: "ok", route, tried, text: capText(markPage(text)) }) };
  }
  const why = failed ? String(failed) : answer.replace(/^BLOCKED:?\s*/i, "").split("\n")[0] || "no reply";
  tried.push(`step 4-5 ${who}: ${why}`);
  return { text: shown({ status: "blocked", route: "stop", tried, text: WEB_READ_STOP }) };
}
