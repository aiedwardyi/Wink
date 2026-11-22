import { describe, expect, it } from "vitest";

import { WEB_READ_RULE, WEB_READ_STOP, type WebReadResult } from "../../shared/web-read.ts";
import { readerPrompt, WEB_READ_TOOL, webRead } from "./web-read-tool.ts";

const blocked: WebReadResult = { status: "blocked", url: "https://www.g2.com/products/x/reviews", route: "fetch", text: "", tried: ["step 2 fetch: DataDome bot check (HTTP 403)", "step 3 your own web tool: failed"], reader: { botId: "c1", name: "Coder", engine: "codex" } };

function harness(first: unknown, reply: Record<string, unknown> | Error) {
  const posts: unknown[] = [];
  const asks: Array<{ toBotId: string; message: string }> = [];
  const api = async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    posts.push(body);
    return (body.remember ? { ok: true } : first) as Record<string, unknown>;
  };
  const askBot = async (toBotId: string, message: string) => {
    asks.push({ toBotId, message });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { api, askBot, posts, asks };
}

const run = async (first: unknown, reply: Record<string, unknown> | Error, args: Record<string, unknown> = { url: blocked.url, own_tool_failed: true }) => {
  const h = harness(first, reply);
  const result = await webRead(args, h.api, h.askBot);
  return { ...h, result, out: JSON.parse(result.text) };
};

describe("web_read tool", () => {
  it("passes an ok read straight through without asking anyone", async () => {
    const { out, asks } = await run({ status: "ok", url: "https://example.com/", route: "fetch", text: "Hello", tried: ["step 2 fetch: ok, 5 chars"] }, { text: "unused" });
    expect(out).toEqual({ status: "ok", route: "fetch", tried: ["step 2 fetch: ok, 5 chars"], text: "Hello" });
    expect(asks).toEqual([]);
  });

  it("keeps next on a step-3 answer so the bot tries its own tool", async () => {
    const { out } = await run({ ...blocked, reader: undefined, next: "Not final." }, { text: "unused" });
    expect(out.next).toBe("Not final.");
  });

  it("labels search snippets as not the page", async () => {
    const { out, posts } = await run(blocked, { botName: "Coder", text: "SEARCH: G2 lists 4.5 stars from 120 reviews; users praise setup speed (g2.com)." });
    expect(out.status).toBe("ok");
    expect(out.route).toBe("search:codex");
    expect(out.text).toMatch(/^From search results, not the page:\nG2 lists 4.5 stars/);
    expect(out.tried.slice(-2)).toEqual(["step 4 @Coder (codex): could not open the page", "step 5 search snippets via @Coder (codex): ok"]);
    expect(posts.at(-1)).toMatchObject({ remember: { route: "search:codex" } });
  });

  it.each<[string, Record<string, unknown> | Error, RegExp]>([
    ["the reader says blocked", { text: "BLOCKED: 403 from g2.com and no useful search results" }, /step 4-5 @Coder \(codex\): 403 from g2.com/],
    ["the ask budget is spent", { limit: "This task already asked 3 bots." }, /already asked 3 bots/],
    ["the ask fails", new Error("HTTP 403"), /HTTP 403/],
    ["the reader is still working", { taskId: "t1", text: "@Coder is still working" }, /still working after the wait limit/],
  ])("stops honestly when %s", async (_name, reply, why) => {
    const { out, posts } = await run(blocked, reply);
    expect(out).toMatchObject({ status: "blocked", route: "stop", text: WEB_READ_STOP });
    expect(out.next).toBeUndefined();
    expect(out.tried.at(-1)).toMatch(why);
    expect(posts.filter((post: any) => post.remember)).toEqual([]);
  });

  it("asks a LinkedIn reader for search results only", async () => {
    const { asks } = await run({ ...blocked, url: "https://www.linkedin.com/company/x/", searchOnly: true }, { text: "BLOCKED: nothing" });
    expect(asks[0]!.message).toContain("never open linkedin.com pages");
    expect(asks[0]!.message).not.toContain("read it for them");
  });

  it("tells every reader to skip reader and mirror sites", () => {
    for (const prompt of [readerPrompt("https://x.com/a/status/1"), readerPrompt("https://www.linkedin.com/in/a", true)]) {
      expect(prompt).toContain("no reader or mirror sites (r.jina.ai, fxtwitter, transcript sites)");
    }
  });

  it("needs a url", async () => {
    const h = harness({}, {});
    expect(await webRead({}, h.api, h.askBot)).toEqual({ text: "web_read needs url.", isError: true });
  });

  it("keeps the shared rule under ~60 tokens and the tool schema small", () => {
    expect(WEB_READ_RULE.length).toBeLessThanOrEqual(240);
    expect(WEB_READ_RULE).toContain("web_read");
    expect(JSON.stringify(WEB_READ_TOOL).length).toBeLessThanOrEqual(520);
  });
});
