// Contract test for the agent-to-agent comms MCP proxy (agents-proxy.ts):
// spawn it exactly the way a driver's mcpServers entry does (process.execPath
// + entry file + env) against a scripted stub of the harness's /api/internal
// endpoints, and drive the MCP stdio surface end to end. No shebang, no
// shell — plain node child, so this runs on every OS like index.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handle } from "./agents-proxy.ts";

const { reply } = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/claude/check-delegation.json", import.meta.url), "utf8"));

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const TOKEN = "test-comms-token";

// scripted harness stub
let stub: Server;
let stubPort = 0;
let lastAuth: string | undefined;
let lastAskBody: any = null;
interface AskBotResponse { botName?: string; text?: string; shown?: boolean; busy?: boolean; error?: string; limit?: string; taskId?: string }
let askResponse: AskBotResponse = { botName: "Helper", text: "hi from helper" };
let lastDelegateBody: any = null;
let lastDelegationUrl: string | null = null;
interface DelegationStatusResponse { status: string; toBotName?: string; result?: string; sameTurn?: boolean }
let delegationStatusResponse: DelegationStatusResponse = { status: "done", toBotName: "Helper", result: "All done." };
let recentDelegationsResponse = { tasks: [{ id: "38930fab", peer: "Helper", status: "done", gist: "All done." }] };
let delegateResponse: unknown = { queued: true, message: "Delegation queued." };
let lastCreateBody: any = null;
let lastCreateChannelBody: any = null;
let lastCredentialBody: any = null;
let lastShowImageBody: any = null;
let lastAskUserBody: any = null;
let lastGenerateImageBody: any = null;
let lastCallApiBody: any = null;
let lastReactBody: any = null;
let lastRoutineQuery = "";
let routinesResponse: unknown = {
  now: "2026-08-28T10:30:00.000Z",
  timeZone: "Asia/Kolkata",
  routines: [
    {
      id: "routine-1",
      name: "Morning brief",
      enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      nextRunAt: "2026-08-31T03:30:00.000Z",
    },
  ],
};
let lastRoutineRequestBody: any = null;
let lastWakeBody: any = null;
interface TaskStateRequestBody {
  pause_automatic_wakes?: boolean;
  fromBotId: string;
  fromThreadId: string;
  goal?: string;
  plan?: Array<{ step: string; status: string }>;
  completed_note?: string;
  next_action?: string;
  blockers?: Array<{ kind: string; note: string }>;
  artifacts?: Array<{ ref: string; label: string }>;
  asks?: Array<{ id?: string; ask?: string; status: string; ref?: string }>;
}
let lastTaskStateBody: TaskStateRequestBody | null = null;
let botWakesPaused = false;
let lastKeepGoingBody: { fromBotId: string; fromThreadId: string; on: boolean; start_after?: string } | null = null;
let keepGoingResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };
let taskStateNotice: string | undefined;
let lastVerify: { auth?: string; body: unknown } | null = null;
let verifyResponse: unknown = { status: "completed", text: "Live Verify: site/index.html - 22 checks, 22 passed, 0 issues, 0 blocked, 0 not run (21 s).\nNo issues found." };
let verifyHold: ((closed: boolean) => void) | null = null;

let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/agents")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          bots: [{ id: "bot-helper", name: "Helper", section: "Work", model: "fake-model", busy: false }],
        }),
      );
    }
    if (req.method === "POST" && req.url === "/api/internal/ask-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAskBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(askResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/delegate-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastDelegateBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(delegateResponse));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/delegations/")) {
      lastDelegationUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url.startsWith("/api/internal/delegations/recent?") ? recentDelegationsResponse : delegationStatusResponse));
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/create-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCreateBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "bot-designer", name: "Pixel", section: "Work" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/create-channel") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCreateChannelBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "channel-two-bot",
            name: lastCreateChannelBody.name,
            memberIds: ["bot-asker", ...(lastCreateChannelBody.memberIds ?? [])],
            section: lastCreateChannelBody.section ?? "Work",
            threadId: "thread-channel-two-bot",
          }),
        );
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/request-credential") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCredentialBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        if (lastCredentialBody.credentialId === "custom") {
          return res.end(JSON.stringify({ messageId: "msg-custom", label: "Acme" }));
        }
        if (lastCredentialBody.credentialId === "openaiImageApiKey") {
          return res.end(JSON.stringify({ alreadyConfigured: true, label: "OpenAI API Key" }));
        }
        res.end(JSON.stringify({ messageId: "msg-key", label: "Gemini API Key" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/react") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        lastReactBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/ask-user") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAskUserBody = JSON.parse(data);
        if (lastAskUserBody.question === "refuse me") {
          res.writeHead(403, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "source thread does not belong to sender" }));
        }
        if (lastAskUserBody.close) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ closed: true }));
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId: "msg-ask" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/show-image") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastShowImageBody = JSON.parse(data);
        if (lastShowImageBody.path.endsWith("fake.png")) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "not a PNG, JPEG, GIF, or WebP image" }));
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId: "msg-img", url: "/api/attachments/abc.png" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/generate-image") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastGenerateImageBody = JSON.parse(data);
        if (lastGenerateImageBody.prompt === "no key") {
          res.writeHead(409, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            error: "No image key saved. Call request_credential with openaiImageApiKey, end the turn, then retry generate_image.",
          }));
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          path: "C:\proj\generated-images\logo-ab12cd34.png",
          ...(lastGenerateImageBody.show ? { url: "/api/attachments/gen.png" } : {}),
        }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/call-api") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCallApiBody = JSON.parse(data);
        if (lastCallApiBody.credentialId === "geminiApiKey") {
          res.writeHead(409, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            error: "No Gemini API key saved. Call request_credential with geminiApiKey, end the turn, then retry call_api.",
          }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (lastCallApiBody.credentialId === "ttsKey") {
          return res.end(JSON.stringify({ status: 200, path: "/proj/api-files/response-ab12cd34.mp3", contentType: "audio/mpeg" }));
        }
        res.end(JSON.stringify({ status: 401, text: "HTTP 401\nbad key [key]" }));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/routines?")) {
      lastRoutineQuery = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(routinesResponse));
    }
    if (req.method === "POST" && req.url === "/api/internal/wake") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastWakeBody = JSON.parse(data);
        const refused = lastWakeBody.at === "refuse";
        res.writeHead(refused ? 400 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(refused ? { error: "You already have 10 pending wakes. Cancel one first." } : lastWakeBody.cancel ? { ok: true } : { id: "wake-1", local: "Sat, Nov 14, 03:45 (Asia/Seoul)" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/routine-requests") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastRoutineRequestBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ requestId: "routine-request-1", summary: "Weekdays at 09:00 (Asia/Kolkata)" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/task-state") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body: TaskStateRequestBody = JSON.parse(data);
        lastTaskStateBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, nextAction: body.next_action, automaticWakesPaused: botWakesPaused || body.pause_automatic_wakes === true, notice: taskStateNotice }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/keep-going") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastKeepGoingBody = JSON.parse(data);
        res.writeHead(keepGoingResponse.status, { "content-type": "application/json" });
        res.end(JSON.stringify(keepGoingResponse.body));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/verify-site") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastVerify = { auth: req.headers.authorization, body: JSON.parse(data) };
        if (verifyHold) {
          const hold = verifyHold;
          res.on("close", () => hold(!res.writableEnded));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(verifyResponse));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    windowsHide: true,
    env: {
      ...process.env,
      OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      OMB_BOT_ID: "bot-asker",
      OMB_THREAD_ID: "thread-asker-routine",
      OMB_COMMS_TOKEN: TOKEN,
      OMB_TURN_DEPTH: "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  child.stdout!.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("agents-proxy MCP surface", () => {
  it("answers the handshake through the exported handler", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await handle({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
      expect(write).toHaveBeenCalledWith(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
        protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "opengrokbot-agents", version: "0.1.0" },
      } })}\n`);
    } finally {
      write.mockRestore();
    }
  });

  it("answers the MCP handshake and lists the tool surface", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("agents");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_bots",
      "update_task_state",
      "ask_bot",
      "delegate_bot",
      "check_delegation",
      "wait_delegation",
      "create_bot",
      "create_channel",
      "react",
      "ask_user",
      "show_image",
      "generate_image",
      "call_api",
      "request_credential",
      "list_routines",
      "propose_routine",
      "propose_routine_action",
      "wake_me",
      "set_keep_going",
      "no_reply_needed",
    ]);
  });

  it("ends a quiet turn with no_reply_needed without calling Wink", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "no_reply_needed");
    expect(tool.inputSchema).toEqual({ type: "object", additionalProperties: false, properties: {} });
    lastKeepGoingBody = null;
    const result = await callTool("no_reply_needed", {});
    expect(result.result.isError).toBe(false);
    expect(result.result.content[0].text).toBe("ok");
    expect(lastKeepGoingBody).toBeNull();
  });

  it("sets keep going through the harness and passes its refusal back", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "set_keep_going");
    expect(tool.description).toContain("keep going, work on your own, be agentic, or agentic mode");
    expect(tool.description).toContain("Agentic Mode");
    expect(tool.inputSchema.required).toEqual(["on"]);
    keepGoingResponse = { status: 200, body: { ok: true } };
    const on = await callTool("set_keep_going", { on: true });
    expect(on.result.isError).toBe(false);
    expect(on.result.content[0].text).toContain("Agentic Mode is on");
    expect(lastKeepGoingBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", on: true });
    keepGoingResponse = { status: 403, body: { error: "only a turn the user started can turn keep going on" } };
    const refused = await callTool("set_keep_going", { on: true });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("user started");
    const bad = await callTool("set_keep_going", { on: "yes" });
    expect(bad.result.isError).toBe(true);
  });

  it("declares and forwards start_after without relaxing the on argument", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "set_keep_going");
    expect(tool.inputSchema.properties.start_after).toEqual(expect.objectContaining({ type: "string" }));
    expect(tool.inputSchema.properties.start_after).not.toHaveProperty("format");
    expect(tool.inputSchema.required).toEqual(["on"]);
    keepGoingResponse = { status: 200, body: { ok: true } };
    const startAfter = "2026-10-21T05:00:00+09:00";
    const delayed = await callTool("set_keep_going", { on: true, start_after: startAfter });
    expect(delayed.result.isError).toBe(false);
    expect(lastKeepGoingBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", on: true, start_after: startAfter });
    expect(delayed.result.content[0].text).toContain(startAfter);
    const bad = await callTool("set_keep_going", { start_after: startAfter });
    expect(bad.result.isError).toBe(true);
  });

  it("rejects non-string start_after without a request", async () => {
    keepGoingResponse = { status: 200, body: { ok: true } };
    lastKeepGoingBody = null;
    const bad = await callTool("set_keep_going", { on: true, start_after: 123 });
    expect(bad.result.isError).toBe(true);
    expect(lastKeepGoingBody).toBeNull();
  });

  it("returns a refused delay without claiming the switch is on", async () => {
    keepGoingResponse = { status: 403, body: { error: "start_after requires Agentic Mode to be on" } };
    const refused = await callTool("set_keep_going", { on: true, start_after: "2026-10-21T05:00:00+09:00" });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("requires Agentic Mode");
  });

  it("asks the user through the harness and returns at once without waiting", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "ask_user");
    expect(tool.description).toContain("It does not pause you");
    expect(tool.description).toContain("including yes/no and permission questions");
    expect(tool.inputSchema.required).toEqual(["question"]);
    const res = await callTool("ask_user", { question: " Ship to prod or staging? ", choices: ["Prod", 3, "Staging"] });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe("Asked. Their answer will arrive as a new message.");
    expect(lastAskUserBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      question: "Ship to prod or staging?",
      choices: ["Prod", 3, "Staging"],
    });
  });

  it("forwards a question close through the same tool without asking again", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "ask_user");
    expect(tool.inputSchema.properties.close).toMatchObject({ type: "boolean" });
    const res = await callTool("ask_user", { question: " Ship it? ", close: true });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe("Closed as answered in chat.");
    expect(lastAskUserBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", question: "Ship it?", close: true });
  });

  it("surfaces ask_user rejections and an empty question as tool errors", async () => {
    const refused = await callTool("ask_user", { question: "refuse me" });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("source thread does not belong to sender");
    const empty = await callTool("ask_user", { question: "  " });
    expect(empty.result.isError).toBe(true);
    expect(empty.result.content[0].text).toContain("needs a question");
  });

  it("publishes a local image into the caller's thread and returns its URL", async () => {
    const res = await callTool("show_image", { path: "C:\\out\\mockup.png", caption: " Home screen " });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("/api/attachments/abc.png");
    expect(lastShowImageBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      path: "C:\\out\\mockup.png",
      caption: "Home screen",
    });
  });

  it("surfaces show_image rejections as tool errors", async () => {
    const fake = await callTool("show_image", { path: "C:\\out\\fake.png" });
    expect(fake.result.isError).toBe(true);
    expect(fake.result.content[0].text).toContain("not a PNG, JPEG, GIF, or WebP image");
    const empty = await callTool("show_image", { path: " " });
    expect(empty.result.isError).toBe(true);
    expect(empty.result.content[0].text).toContain("needs a path");
  });

  it("generates an image through the harness and returns its path and URL", async () => {
    const res = await callTool("generate_image", { prompt: " a teal fox logo ", filename: "logo", size: "1536x1024" });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("C:\proj\generated-images\logo-ab12cd34.png");
    expect(res.result.content[0].text).toContain("/api/attachments/gen.png");
    expect(lastGenerateImageBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      prompt: "a teal fox logo",
      show: true,
      filename: "logo",
      size: "1536x1024",
    });
    const hidden = await callTool("generate_image", { prompt: "icon", show: false });
    expect(hidden.result.content[0].text).not.toContain("/api/attachments/");
    expect(lastGenerateImageBody.show).toBe(false);
  });

  it("tells the bot how to get an image key when none is saved", async () => {
    const res = await callTool("generate_image", { prompt: "no key" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Call request_credential with openaiImageApiKey");
    const empty = await callTool("generate_image", { prompt: " " });
    expect(empty.result.content[0].text).toContain("needs a prompt");
  });

  it("advertises multipart uploads and forwards the form to the key broker", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "call_api");
    expect(tool.description).toContain("For file uploads (multipart), pass form with fields and files (absolute paths inside your working folder).");
    expect(tool.inputSchema.properties.form).toMatchObject({
      type: "object",
      properties: {
        fields: { type: "object", additionalProperties: { type: "string" } },
        files: { type: "array", items: {
          type: "object", required: ["field", "path"],
          properties: { field: { type: "string" }, path: { type: "string" }, filename: { type: "string" }, content_type: { type: "string" } },
        } },
      },
    });
    const form = { fields: { model: "asr" }, files: [{ field: "audio", path: "/proj/speech.m4a", filename: "voice.m4a", content_type: "audio/mp4" }] };
    await callTool("call_api", { credential_id: "xaiApiKey", method: "POST", url: "https://api.x.ai/v1/chat", form });
    expect(lastCallApiBody.form).toEqual(form);
    expect(lastCallApiBody).not.toHaveProperty("body");
  });

  it("calls an API through the harness key broker", async () => {
    const res = await callTool("call_api", { credential_id: "xaiApiKey", method: "post", url: "https://api.x.ai/v1/chat", body: { q: 1 } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("HTTP 401\nbad key [key]");
    expect(lastCallApiBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      credentialId: "xaiApiKey",
      method: "POST",
      url: "https://api.x.ai/v1/chat",
      body: { q: 1 },
    });
    const audio = await callTool("call_api", { credential_id: "ttsKey", method: "GET", url: "https://api.elevenlabs.io/v1/x" });
    expect(audio.result.isError).toBe(false);
    expect(audio.result.content[0].text).toContain("/proj/api-files/response-ab12cd34.mp3");
    const missing = await callTool("call_api", { credential_id: "geminiApiKey", method: "GET", url: "https://generativelanguage.googleapis.com/v1beta/models" });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain("Call request_credential with geminiApiKey");
  });

  it("points a configured image key at generate_image", async () => {
    const res = await callTool("request_credential", { credential_id: "openaiImageApiKey" });
    expect(res.result.content[0].text).toBe("OpenAI API Key is already configured. Use generate_image.");
  });

  it("forwards durable task progress with source ownership", async () => {
    lastTaskStateBody = null;
    const res = await callTool("update_task_state", {
      goal: "Publish the weekly brief",
      plan: [{ step: "Verify citations", status: "active" }],
      completed_note: "Drafted five sections",
      next_action: "Verify citations",
      blockers: [],
      artifacts: [{ ref: "brief.md", label: "Weekly brief" }],
    });

    expect(lastTaskStateBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      goal: "Publish the weekly brief",
      plan: [{ step: "Verify citations", status: "active" }],
      completed_note: "Drafted five sections",
      next_action: "Verify citations",
      blockers: [],
      artifacts: [{ ref: "brief.md", label: "Weekly brief" }],
    });
    expect(res.result.content[0].text).toContain("Next action: Verify citations");
  });

  it("appends the server's clip notice to the saved result", async () => {
    taskStateNotice = "Clipped to fit: completed_note (354 > 300).";
    const res = await callTool("update_task_state", { next_action: "Verify citations" });
    taskStateNotice = undefined;
    expect(res.result.content[0].text).toBe("Task record saved. Next action: Verify citations\nClipped to fit: completed_note (354 > 300).");
    const clean = await callTool("update_task_state", { next_action: "Verify citations" });
    expect(clean.result.content[0].text).toBe("Task record saved. Next action: Verify citations");
  });

  it("forwards an explicit wake pause without claiming the current turn ended", async () => {
    lastTaskStateBody = null;
    const res = await callTool("update_task_state", { pause_automatic_wakes: true });
    expect(lastTaskStateBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", pause_automatic_wakes: true });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("End this turn");
    expect(res.result.content[0].text).not.toContain("You can change models now");
  });

  it("keeps later turns running on a paused bot", async () => {
    botWakesPaused = true;
    const res = await callTool("update_task_state", { next_action: "Verify citations" });
    botWakesPaused = false;
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("Next action: Verify citations");
    expect(res.result.content[0].text).not.toContain("End this turn");
  });

  it("does not let a bot clear a user wake pause", async () => {
    lastTaskStateBody = null;
    const res = await callTool("update_task_state", { pause_automatic_wakes: false });
    expect(res.result.isError).toBe(true);
    expect(lastTaskStateBody).toBeNull();
  });

  it("rejects blank task fields before calling the harness", async () => {
    const list = await rpc("tools/list");
    const update = list.result.tools.find((tool: { name: string }) => tool.name === "update_task_state");
    expect(update.inputSchema.properties.goal).toMatchObject({ minLength: 1, pattern: "\\S" });
    expect(update.inputSchema.properties.plan.items.properties.step).toMatchObject({ minLength: 1, pattern: "\\S" });
    const limits: Array<[Record<string, unknown>, "maxLength" | "maxItems", number]> = [
      [update.inputSchema.properties.goal, "maxLength", 500],
      [update.inputSchema.properties.plan, "maxItems", 20],
      [update.inputSchema.properties.plan.items.properties.step, "maxLength", 200],
      [update.inputSchema.properties.completed_note, "maxLength", 300],
      [update.inputSchema.properties.next_action, "maxLength", 300],
      [update.inputSchema.properties.blockers, "maxItems", 10],
      [update.inputSchema.properties.blockers.items.properties.note, "maxLength", 300],
      [update.inputSchema.properties.artifacts, "maxItems", 20],
      [update.inputSchema.properties.artifacts.items.properties.ref, "maxLength", 500],
      [update.inputSchema.properties.artifacts.items.properties.label, "maxLength", 200],
    ];
    for (const [field, key, limit] of limits) {
      expect(field[key]).toBe(limit);
      expect(field.description).toContain(String(limit));
    }

    lastTaskStateBody = null;
    const res = await callTool("update_task_state", {
      plan: [{ step: "   ", status: "active" }],
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("cannot be blank");
    expect(lastTaskStateBody).toBeNull();
  });

  it("accepts an empty next_action in the tool schema and forwards it", async () => {
    const list = await rpc("tools/list");
    const update = list.result.tools.find((tool: { name: string }) => tool.name === "update_task_state");
    expect(update.inputSchema.properties.next_action.minLength).toBeUndefined();
    expect(update.inputSchema.properties.next_action.pattern).toBe("^$|\\S");
    expect(update.inputSchema.properties.next_action.description).toContain("Empty string clears it.");

    lastTaskStateBody = null;
    const cleared = await callTool("update_task_state", { next_action: "" });
    expect(cleared.result.isError).not.toBe(true);
    expect(lastTaskStateBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      next_action: "",
    });

    lastTaskStateBody = null;
    const spaces = await callTool("update_task_state", { next_action: "   " });
    expect(spaces.result.isError).toBe(true);
    expect(spaces.result.content[0].text).toContain("cannot be blank");
    expect(lastTaskStateBody).toBeNull();
  });

  it("rejects unknown and misshapen task fields with the allowed list", async () => {
    lastTaskStateBody = null;
    const unknown = await callTool("update_task_state", { goal: "Ship", notes: "x", done: true });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toContain("unknown field notes, done");
    expect(unknown.result.content[0].text).toContain("allowed: goal, plan, completed_note, next_action, blockers, artifacts");

    const empty = await callTool("update_task_state", {});
    expect(empty.result.content[0].text).toContain("allowed: goal, plan");

    const plan = await callTool("update_task_state", { plan: "step one, step two" });
    expect(plan.result.isError).toBe(true);
    expect(plan.result.content[0].text).toContain("plan must be an array");
    expect(lastTaskStateBody).toBeNull();
  });

  it("publishes a flat asks schema and forwards asks to the harness", async () => {
    const list = await rpc("tools/list");
    const update = list.result.tools.find((tool: { name: string }) => tool.name === "update_task_state");
    const asks = update.inputSchema.properties.asks;
    expect(JSON.stringify(asks)).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
    expect(asks).toMatchObject({ type: "array", maxItems: 20 });
    expect(asks.items.required).toEqual(["status"]);
    expect(asks.items.properties.status.enum).toEqual(["open", "building", "waiting-for-user", "done", "declined"]);
    expect(asks.items.properties.ask).toMatchObject({ maxLength: 80, pattern: "\\S" });
    expect(asks.items.properties.ref).toMatchObject({ maxLength: 80, pattern: "^$|\\S" });
    for (const [field, limit] of [[asks, 20], [asks.items.properties.ask, 80], [asks.items.properties.ref, 80]] as const) {
      expect(field.description).toContain(String(limit));
    }

    lastTaskStateBody = null;
    const sent = [
      { ask: "Review the model picker PR", status: "waiting-for-user", ref: "PR #1348" },
      { id: "A2", status: "done" },
    ];
    taskStateNotice = "Asks saved: added A3; 2 open.";
    const res = await callTool("update_task_state", { asks: sent });
    taskStateNotice = undefined;
    expect(lastTaskStateBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", asks: sent });
    expect(res.result.content[0].text).toBe("Task record saved. Next action: continue the current plan\nAsks saved: added A3; 2 open.");
  });

  it("rejects misshapen asks before calling the harness", async () => {
    lastTaskStateBody = null;
    const text = await callTool("update_task_state", { asks: "fix the login" });
    expect(text.result.isError).toBe(true);
    expect(text.result.content[0].text).toContain("asks must be an array");
    const blank = await callTool("update_task_state", { asks: [{ ask: "   ", status: "open" }] });
    expect(blank.result.isError).toBe(true);
    expect(blank.result.content[0].text).toContain("cannot be blank");
    const unknown = await callTool("update_task_state", { todo: [] });
    expect(unknown.result.content[0].text).toContain("allowed: goal, plan, completed_note, next_action, blockers, artifacts, asks, pause_automatic_wakes.");
    expect(lastTaskStateBody).toBeNull();
  });

  it("publishes a flat routine schedule schema that survives provider conversion", async () => {
    const list = await rpc("tools/list");
    const create = list.result.tools.find((t: { name: string }) => t.name === "propose_routine");
    expect(create.inputSchema.required).toEqual(["name", "instructions", "schedule"]);
    const schedule = create.inputSchema.properties.schedule;
    // No composition keywords anywhere in the tool surface: several agent
    // CLIs flatten or drop oneOf/anyOf/const when converting MCP tools for
    // their model API, and a model that never saw the branches guesses
    // shapes forever (the 0.1.38 field failure).
    expect(JSON.stringify(create.inputSchema)).not.toMatch(/"oneOf"|"anyOf"|"allOf"|"const"/);
    expect(schedule.type).toBe("object");
    expect(schedule.required).toEqual(["type"]);
    expect(schedule.properties.type.enum).toEqual(["once", "weekly", "daily"]);
    expect(schedule.properties.weekdays.items.enum).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
    expect(create.description).toContain("does NOT enable");
  });

  it("list_bots renders the roster and authenticates with the shared token", async () => {
    const res = await callTool("list_bots", {});
    const text = res.result.content[0].text;
    expect(text).toContain("Helper");
    expect(text).toContain("bot-helper");
    expect(text).toContain("section: Work");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("ask_bot forwards sender + depth and returns the reply", async () => {
    askResponse = { botName: "Helper", text: "hi from helper" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("Helper replied:");
    expect(res.result.content[0].text).toContain("hi from helper");
    expect(lastAskBody).toMatchObject({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      toBotId: "bot-helper",
      message: "ping",
      depth: 0,
    });
  });

  it("tells the bot the user sees the reply only when the chat shows it", async () => {
    const line = "The user sees this reply in the chat, so add only your own take.";
    for (const shown of [true, false]) {
      askResponse = { botName: "Helper", text: "hi from helper", shown };
      const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
      expect(res.result.content[0].text).toBe(`Helper replied:\nhi from helper${shown ? `\n\n${line}` : ""}`);
    }
  });

  it("hands back a timed-out ask's task id and says the limit in the description", async () => {
    const text = "@Helper is still working (over 4 min). Task id: task-ask1. Collect the reply with wait_delegation; do not ask again.";
    askResponse = { botName: "Helper", text, taskId: "task-ask1", shown: false };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toBe(text);
    expect(res.result.isError).toBeFalsy();
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "ask_bot");
    expect(tool.description).toContain("4 minutes");
    expect(tool.description).toContain("wait_delegation");
  });

  it("renders a busy peer as a clean answer, not an error", async () => {
    askResponse = { busy: true };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("busy");
    expect(res.result.isError).toBeFalsy();
  });

  it("surfaces the harness's depth refusal as a tool error", async () => {
    askResponse = { error: "message chains are limited to one hop" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("one hop");
  });

  it.each([
    "You already have 4 teammate messages waiting. Collect those replies first.",
    "This request reached its 24 bot turn limit. Finish with what you have; the user can send a message to continue.",
  ])("reports an ask limit as a limit, not as an unreachable peer: %s", async (limit) => {
    askResponse = { limit };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toBe(limit);
    expect(res.result.content[0].text).not.toContain("Couldn't reach that bot");
  });

  it("forwards the source thread when queueing a delegation", async () => {
    delegateResponse = { queued: true, message: "Delegation queued." };
    const res = await callTool("delegate_bot", {
      bot_id: "bot-helper",
      message: "take this",
      reason: "follow-up",
    });
    expect(res.result.content[0].text).toContain("Delegation queued");
    expect(lastDelegateBody).toMatchObject({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      toBotId: "bot-helper",
      message: "take this",
      reason: "follow-up",
      depth: 0,
    });
  });

  it("returns queue refusal guidance to the agent as a tool error", async () => {
    delegateResponse = { error: "message chains are limited to one hop" };
    const res = await callTool("delegate_bot", { bot_id: "bot-helper", message: "take this" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("limited to one hop");
  });

  it("lets a Chief create a bounded specialist through the harness", async () => {
    const res = await callTool("create_bot", {
      name: "Pixel",
      role: "Product designer",
      instructions: "Design and review the user experience.",
    });
    expect(res.result.content[0].text).toContain("Created @Pixel in Work");
    expect(res.result.content[0].text).toContain("create_channel");
    expect(lastCreateBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      name: "Pixel",
      role: "Product designer",
      instructions: "Design and review the user experience.",
    });
  });

  it("create_channel tells the model to call the tool instead of scanning localhost", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "create_channel");
    expect(tool).toBeTruthy();
    expect(tool.description).toMatch(/two-bot channel|shared channel|shared room/i);
    expect(tool.description).toMatch(/Never scan/i);
    expect(tool.description).toContain("ask_bot");
    expect(tool.inputSchema.required).toEqual(["name", "member_ids"]);
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"oneOf"|"anyOf"|"allOf"|"const"/);
  });

  it("forwards a two-bot channel to the harness and points the user at the room", async () => {
    lastCreateChannelBody = null;
    const res = await callTool("create_channel", {
      name: "Skye & Nova",
      member_ids: ["bot-designer"],
      // a room joins the sender's section; a section the model invents is
      // never forwarded, so it cannot file the user's rooms for them
      section: "Work",
      bulletin: "Talk here, not in 1:1.",
    });
    expect(lastCreateChannelBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      name: "Skye & Nova",
      memberIds: ["bot-designer"],
      bulletin: "Talk here, not in 1:1.",
    });
    expect(res.result.content[0].text).toContain("Created channel");
    expect(res.result.content[0].text).toContain("Skye & Nova");
    expect(res.result.content[0].text).toContain("channel-two-bot");
    expect(res.result.content[0].text).toMatch(/ask_bot/i);
    expect(res.result.content[0].text).toMatch(/1:1/);
    expect(res.result.isError).toBeFalsy();
  });

  it("rejects create_channel without a name or members before calling the harness", async () => {
    lastCreateChannelBody = null;
    const missingName = await callTool("create_channel", { member_ids: ["bot-designer"] });
    expect(missingName.result.isError).toBe(true);
    expect(missingName.result.content[0].text).toContain("name");
    expect(lastCreateChannelBody).toBeNull();

    const missingMembers = await callTool("create_channel", { name: "Empty" });
    expect(missingMembers.result.isError).toBe(true);
    expect(missingMembers.result.content[0].text).toContain("member_ids");
    expect(lastCreateChannelBody).toBeNull();
  });

  it("requests an allowlisted credential without putting a secret in the request", async () => {
    const res = await callTool("request_credential", {
      credential_id: "geminiApiKey",
      reason: "The selected model needs it.",
    });
    expect(res.result.content[0].text).toContain("secure Gemini API Key card");
    expect(res.result.content[0].text).toContain("End this turn");
    expect(lastCredentialBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      credentialId: "geminiApiKey",
      reason: "The selected model needs it.",
    });
    expect(JSON.stringify(lastCredentialBody)).not.toContain("secret");
  });

  it("requests a custom key locked to one host", async () => {
    const res = await callTool("request_credential", { credential_id: "custom", service: { name: "Acme", host: "api.acme.dev" } });
    expect(res.result.content[0].text).toContain("call_api with credential_id custom:api.acme.dev");
    expect(lastCredentialBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      credentialId: "custom",
      service: { name: "Acme", host: "api.acme.dev", header: "authorization", prefix: "Bearer " },
    });
    lastCredentialBody = null;
    for (const service of [{ name: "Acme", host: "https://api.acme.dev" }, { name: "Acme", host: "api.acme.dev", header: "cookie" }]) {
      const bad = await callTool("request_credential", { credential_id: "custom", service });
      expect(bad.result.isError).toBe(true);
    }
    expect(lastCredentialBody).toBeNull();
    const call = await callTool("call_api", { credential_id: "custom:api.acme.dev", method: "GET", url: "https://api.acme.dev/v1" });
    expect(call.result.content[0].text).not.toContain("secret");
    expect(lastCallApiBody.credentialId).toBe("custom:api.acme.dev");
  });

  it("rejects credential ids outside the fixed allowlist locally", async () => {
    lastCredentialBody = null;
    const res = await callTool("request_credential", { credential_id: "arbitrary.config.path" });
    expect(res.result.isError).toBe(true);
    expect(lastCredentialBody).toBeNull();
  });

  it("hands the delegator its task id and the tools to read the outcome", async () => {
    delegateResponse = {
      queued: true,
      taskId: "task-abc123",
      message: "Delegation queued — @Helper will pick it up after your current turn finishes.",
    };
    const res = await callTool("delegate_bot", { bot_id: "bot-helper", message: "do the thing" });
    expect(res.result.content[0].text).toContain("Task id: task-abc123");
    expect(res.result.content[0].text).toContain("wait_delegation");
    expect(res.result.content[0].text).toContain("in a later turn");
    delegateResponse = { queued: true, message: "Delegation queued." };
  });

  it("replays a recorded Claude check_delegation call over MCP stdio", async () => {
    const result = await callTool(reply.call.name.replace("mcp__agents__", ""), reply.call.input);
    expect(result.result.isError).toBe(false);
    expect(result.result.content[0].text).toBe(`@Helper finished task ${reply.call.input.task_id}:\nAll done.`);
    expect(lastDelegationUrl).toBe(`/api/internal/delegations/${reply.call.input.task_id}?fromBotId=bot-asker&fromThreadId=thread-asker-routine&wait_ms=0`);
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("check_delegation lists recent tasks when task_id is omitted", async () => {
    const result = await callTool("check_delegation", {});
    expect(result.result.isError).not.toBe(true);
    expect(result.result.content[0].text).toContain('38930fab -> @Helper: done "All done."');
    expect(lastDelegationUrl).toContain("/api/internal/delegations/recent?");
    expect(lastDelegationUrl).toContain("fromBotId=bot-asker");
    const list = await rpc("tools/list");
    const check = list.result.tools.find((tool: { name: string }) => tool.name === "check_delegation");
    const wait = list.result.tools.find((tool: { name: string }) => tool.name === "wait_delegation");
    expect(check.inputSchema.required ?? []).not.toContain("task_id");
    expect(wait.inputSchema.required).toContain("task_id");
    recentDelegationsResponse = { tasks: [] };
    expect((await callTool("check_delegation", {})).result.content[0].text).toBe("No recent delegations.");
  });

  it("check/wait_delegation: flat schemas, guided errors, and the read-back wire", async () => {
    const list = await rpc("tools/list");
    for (const name of ["check_delegation", "wait_delegation"]) {
      const tool = list.result.tools.find((t: { name: string }) => t.name === name);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
      expect(tool.inputSchema.properties.task_id.description).toContain("unique prefix of 8+ characters");
    }

    lastDelegationUrl = null;
    const bad = await callTool("check_delegation", { task_id: "!" });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('"task_id"');
    expect(lastDelegationUrl).toBeNull(); // guidance is free

    const done = await callTool("check_delegation", { task_id: "task-abc123" });
    expect(done.result.content[0].text).toContain("@Helper finished task task-abc123");
    expect(done.result.content[0].text).toContain("All done.");
    expect(lastDelegationUrl).toContain("/api/internal/delegations/task-abc123?");
    expect(lastDelegationUrl).toContain("wait_ms=0");
    expect(lastDelegationUrl).toContain("fromBotId=bot-asker");

    delegationStatusResponse = { status: "queued", toBotName: "Helper" };
    const waiting = await callTool("wait_delegation", { task_id: "task-abc123", timeout_seconds: 45 });
    expect(waiting.result.content[0].text).toContain("still queued");
    expect(waiting.result.content[0].text).toContain("after 45s");
    expect(lastDelegationUrl).toContain("wait_ms=45000");

    delegationStatusResponse = { status: "queued", toBotName: "Helper", sameTurn: true };
    const sameTurn = await callTool("wait_delegation", { task_id: "task-abc123" });
    expect(sameTurn.result.content[0].text).toContain("when your turn ends");
    expect(sameTurn.result.content[0].text).not.toContain("still queued");
    const wait = list.result.tools.find((t: { name: string }) => t.name === "wait_delegation");
    expect(wait.description).toContain("only sent when this turn ends");
    delegationStatusResponse = { status: "done", toBotName: "Helper", result: "All done." };
  });

  it("lists only the current bot's routines with authoritative time context", async () => {
    routinesResponse = {
      now: "2026-08-28T10:30:00.000Z",
      timeZone: "Asia/Kolkata",
      routines: [{ id: "routine-1", name: "Morning brief", enabled: true }],
    };
    const res = await callTool("list_routines", {});
    expect(res.result.content[0].text).toContain("routine-1");
    expect(res.result.content[0].text).toContain("Asia/Kolkata");
    const query = new URL(lastRoutineQuery, "http://localhost").searchParams;
    expect(query.get("fromBotId")).toBe("bot-asker");
    expect(query.get("fromThreadId")).toBe("thread-asker-routine");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("lists one short row per routine and the full record for routine_id", async () => {
    const routine = (id: string, extra: object) => ({
      id, name: `Brief ${id}`, instructions: "Summarize today's priorities. ".repeat(40), instructionsTruncated: false, enabled: true, runOn: "local", durationMinutes: 30,
      schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] }, nextRunAt: "2026-08-31T03:30:00.000Z", latestRun: null, ...extra,
    });
    routinesResponse = {
      now: "2026-08-28T10:30:00.000Z",
      timeZone: "Asia/Kolkata",
      routines: [routine("r1", {}), routine("r2", { enabled: false, nextRunAt: null, schedule: { type: "once", at: "2026-09-01T04:00:00.000Z" } })],
    };
    const list = await callTool("list_routines", {});
    expect(list.result.content[0].text).toBe([
      "This bot's routines (current time: 2026-08-28T10:30:00.000Z; timezone: Asia/Kolkata), as id | name | schedule | status | next run:",
      "- r1 | Brief r1 | weekly 09:00 monday,friday | enabled | 2026-08-31T03:30:00.000Z",
      "- r2 | Brief r2 | once 2026-09-01T04:00:00.000Z | paused | none",
    ].join("\n"));
    const one = await callTool("list_routines", { routine_id: "r2" });
    expect(one.result.content[0].text).toBe(`Routine r2 (current time: 2026-08-28T10:30:00.000Z; timezone: Asia/Kolkata):\n${JSON.stringify(routine("r2", { enabled: false, nextRunAt: null, schedule: { type: "once", at: "2026-09-01T04:00:00.000Z" } }), null, 2)}`);
    const missing = await callTool("list_routines", { routine_id: "nope" });
    expect(missing.result.isError).toBe(true);
    const tools = await rpc("tools/list");
    const tool = tools.result.tools.find((entry: { name: string }) => entry.name === "list_routines");
    expect(tool.description).toContain("up to 2,000 characters of its instructions");
    expect(tool.inputSchema.properties.routine_id.type).toBe("string");
  });

  it("sets, refuses and cancels a self-wake without a confirmation card", async () => {
    lastWakeBody = null;
    lastRoutineRequestBody = null;
    const set = await callTool("wake_me", { at: "2026-11-14T03:45:00+09:00", note: "resume the deploy check" });
    expect(set.result.isError).toBeFalsy();
    expect(set.result.content[0].text).toContain("wake-1");
    expect(set.result.content[0].text).toContain("03:45");
    expect(lastWakeBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", at: "2026-11-14T03:45:00+09:00", note: "resume the deploy check" });
    expect(lastRoutineRequestBody).toBeNull();
    const refused = await callTool("wake_me", { at: "refuse", note: "x" });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("10 pending wakes");
    const cancelled = await callTool("wake_me", { cancel: "wake-1" });
    expect(cancelled.result.isError).toBeFalsy();
    expect(lastWakeBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", cancel: "wake-1" });
    const missing = await callTool("wake_me", {});
    expect(missing.result.isError).toBe(true);
  });

  it("proposes a weekly routine through a confirmation-only request", async () => {
    lastRoutineRequestBody = null;
    const res = await callTool("propose_routine", {
      name: "Morning brief",
      instructions: "Summarize today's priorities.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] },
      run_on: "maus",
      duration_minutes: 45,
    });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "create",
      routine: {
        name: "Morning brief",
        instructions: "Summarize today's priorities.",
        schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] },
        runOn: "maus",
        durationMinutes: 45,
      },
    });
    expect(res.result.content[0].text).toContain("confirmation card");
    expect(res.result.content[0].text).toContain("has not been applied");
    expect(res.result.content[0].text).toContain("do not claim");
    expect(res.result.isError).toBeFalsy();
  });

  it("proposes a one-time routine with the explicit-offset timestamp intact", async () => {
    await callTool("propose_routine", {
      name: "Send follow-up",
      instructions: "Draft the follow-up for review.",
      schedule: { type: "once", at: "2026-09-01T09:00:00+05:30" },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "once",
      at: "2026-09-01T09:00:00+05:30",
    });
  });

  it("proposes routine updates and destructive actions without applying them", async () => {
    const update = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: { name: "Weekday brief", duration_minutes: 60 },
    });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "update",
      routineId: "routine-1",
      changes: { name: "Weekday brief", durationMinutes: 60 },
    });
    expect(update.result.content[0].text).toContain("has not been applied");

    await callTool("propose_routine_action", { routine_id: "routine-1", action: "delete" });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "delete",
      routineId: "routine-1",
    });
  });

  it("coerces the schedule shapes models actually send", async () => {
    // "daily" is the natural word for every-day; it becomes weekly on all
    // seven days on the wire, so the harness dialect stays unchanged.
    await callTool("propose_routine", {
      name: "Daily check",
      instructions: "Check things.",
      schedule: { type: "daily", time: "09:00" },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "weekly",
      time: "09:00",
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });

    // Capitalized and short weekday names have one obvious meaning.
    await callTool("propose_routine", {
      name: "Caps",
      instructions: "x.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["Monday", "FRI"] },
    });
    expect(lastRoutineRequestBody.routine.schedule.weekdays).toEqual(["monday", "friday"]);

    // Models routinely deliver nested objects as JSON strings.
    await callTool("propose_routine", {
      name: "Str",
      instructions: "x.",
      schedule: JSON.stringify({ type: "weekly", time: "09:00", weekdays: ["monday"] }),
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({ type: "weekly", time: "09:00", weekdays: ["monday"] });
  });

  it("answers unsupported schedules with instructions, before calling the harness", async () => {
    lastRoutineRequestBody = null;
    const interval = await callTool("propose_routine", {
      name: "Interval",
      instructions: "x.",
      schedule: { type: "interval", minutes: 30 },
    });
    expect(interval.result.isError).toBe(true);
    expect(interval.result.content[0].text).toContain("sub-day intervals");
    expect(interval.result.content[0].text).toContain('"type":"daily"');

    const noDays = await callTool("propose_routine", {
      name: "NoDays",
      instructions: "x.",
      schedule: { type: "weekly", time: "09:00" },
    });
    expect(noDays.result.isError).toBe(true);
    expect(noDays.result.content[0].text).toContain("weekdays");
    expect(noDays.result.content[0].text).toContain("daily");

    const unknown = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: { schedule: { type: "fortnightly", time: "09:00" } },
    });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toContain("Unknown schedule type");
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("rejects malformed routine proposals before calling the harness", async () => {
    lastRoutineRequestBody = null;
    const missing = await callTool("propose_routine", {
      name: "No schedule",
      instructions: "This cannot be scheduled yet.",
    });
    expect(missing.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();

    const badUpdate = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: {},
    });
    expect(badUpdate.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "made_up", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });

  it("requires bot_id and message", async () => {
    const res = await callTool("ask_bot", { bot_id: "", message: "" });
    expect(res.result.isError).toBe(true);
  });
});

function probeWithIdentity(identity: Record<string, string>, name = "react", args: unknown = { emoji: "👍" }, proxyFile = PROXY): Promise<{ list: any; call: any }> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMB_")));
  const proxy = spawn(process.execPath, [proxyFile], {
    windowsHide: true,
    env: { ...inherited, OMB_HARNESS_URL: "http://127.0.0.1:9", ...identity },
    stdio: ["pipe", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const replies = new Map<number, any>();
    const timer = setTimeout(() => {
      proxy.kill();
      reject(new Error("proxy probe timed out"));
    }, 10_000);
    let buf = "";
    proxy.stdout!.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        replies.set(msg.id, msg);
      }
      if (!replies.has(1) || !replies.has(2)) return;
      clearTimeout(timer);
      proxy.kill();
      resolve({ list: replies.get(1), call: replies.get(2) });
    });
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}

describe("agents-proxy identity gate", () => {
  it.each([
    ["no identity", {}],
    ["a terminal-only identity", { OMB_BOT_ID: "bot-asker", OMB_COMMS_TOKEN: TOKEN }],
  ])("lists no tools and refuses calls with %s", async (_label, identity) => {
    const { list, call } = await probeWithIdentity(identity);
    expect(list.result.tools).toEqual([]);
    expect(call.error.code).toBe(-32602);
  });

  it("lists every tool with a complete identity at depth 0", async () => {
    const { list } = await probeWithIdentity({ OMB_BOT_ID: "bot-new", OMB_THREAD_ID: "thread-new", OMB_COMMS_TOKEN: TOKEN, OMB_TURN_DEPTH: "0" });
    expect(list.result.tools).toHaveLength(20);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("set_keep_going");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["ask_bot", "delegate_bot", "ask_user", "update_task_state", "check_delegation"]));
  });

  it.each([1, 2])("lists only safe peer tools at depth %s", async (depth) => {
    const { list } = await probeWithIdentity({ OMB_BOT_ID: "bot-new", OMB_THREAD_ID: "thread-new", OMB_COMMS_TOKEN: TOKEN, OMB_TURN_DEPTH: String(depth), OMB_TEAM_REPORTS: "1" });
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "check_delegation", "list_bots", "list_routines", "update_task_state", "wait_delegation",
    ]);
  });

  it.each(["ask_bot", "delegate_bot", "create_bot", "create_channel", "ask_user", "react", "show_image", "generate_image", "call_api", "request_credential", "propose_routine", "propose_routine_action", "wake_me", "set_keep_going", "report_issue"])("refuses %s from a peer turn before calling the harness", async (name) => {
    const { call } = await probeWithIdentity({ OMB_BOT_ID: "bot-new", OMB_THREAD_ID: "thread-new", OMB_COMMS_TOKEN: TOKEN, OMB_TURN_DEPTH: "1", OMB_TEAM_REPORTS: "1" }, name);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("unavailable in peer turns");
  });

  it.each([
    ["update_task_state", { completed_note: "Verified peer work" }],
    ["check_delegation", { task_id: "38930fab" }],
  ])("keeps %s callable in a peer turn", async (name, args) => {
    const { call } = await probeWithIdentity({ OMB_BOT_ID: "bot-asker", OMB_THREAD_ID: "thread-asker-routine", OMB_COMMS_TOKEN: TOKEN, OMB_TURN_DEPTH: "1", OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}` }, name as string, args);
    expect(call.result.isError).toBeFalsy();
  });});

describe("agents-proxy catalog", () => {
  const identity = (depth = 0) => ({ OMB_BOT_ID: "bot-asker", OMB_THREAD_ID: "thread-asker-routine", OMB_COMMS_TOKEN: TOKEN, OMB_TURN_DEPTH: String(depth), OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`, OMB_WINK_TOOL_CATALOG: "1" });
  const names = (list: any): string[] => list.result.tools.map((tool: { name: string }) => tool.name);

  it("replaces only the five ask-driven definitions with the bounded pair", async () => {
    const { list } = await probeWithIdentity(identity(), "find_wink_tool", { query: "images" });
    expect(names(list)).toEqual(["list_bots", "update_task_state", "ask_bot", "delegate_bot", "check_delegation", "wait_delegation", "react", "ask_user", "show_image", "list_routines", "propose_routine", "propose_routine_action", "wake_me", "set_keep_going", "no_reply_needed", "find_wink_tool", "call_wink_tool"]);
    expect(JSON.stringify(list.result.tools.slice(-2)).length).toBeLessThanOrEqual(1200);
  });

  it.each([
    ["create_bot", { name: "Pixel", role: "Designer", instructions: "Draw things." }],
    ["create_channel", { name: "Design", member_ids: ["bot-helper"] }],
    ["generate_image", { prompt: "A test image", show: true }],
    ["call_api", { credential_id: "ttsKey", method: "POST", url: "https://api.example.com/audio" }],
    ["request_credential", { credential_id: "geminiApiKey", reason: "Task needs it" }],
  ])("runs %s through its original handler and returns the same artifact or card", async (name, args) => {
    const direct = await probeWithIdentity({ ...identity(), OMB_WINK_TOOL_CATALOG: "0" }, name as string, args);
    const gateway = await probeWithIdentity(identity(), "call_wink_tool", { name, arguments: args });
    expect(gateway.call.result).toMatchObject({ ...direct.call.result, _meta: { winkTool: name } });
    expect(gateway.call.result.isError).toBeFalsy();
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ["react", { emoji: "👍" }],
    ["show_image", { path: "/proj/image.png", caption: "Preview" }],
    ["list_routines", {}],
    ["propose_routine", { name: "Brief", instructions: "Check things.", schedule: { type: "daily", time: "09:00" } }],
    ["propose_routine_action", { routine_id: "routine-1", action: "delete" }],
  ])("keeps %s loaded: one direct call, never through the gateway", async (name, args) => {
    const direct = await probeWithIdentity(identity(), name as string, args);
    expect(direct.call.result.isError).toBeFalsy();
    if (name === "react") expect(lastReactBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", emoji: "👍" });
    expect(direct.list.result.tools.map((tool: { name: string }) => tool.name)).toContain(name);
    const gateway = await probeWithIdentity(identity(), "call_wink_tool", { name, arguments: args });
    expect(gateway.call.result.isError).toBe(true);
  });

  it.each(["create_bot", "create_channel", "generate_image", "request_credential"])("preserves %s argument refusals", async (name) => {
    const direct = await probeWithIdentity({ ...identity(), OMB_WINK_TOOL_CATALOG: "0" }, name, {});
    const gateway = await probeWithIdentity(identity(), "call_wink_tool", { name, arguments: {} });
    expect(gateway.call.result.content).toEqual(direct.call.result.content);
    expect(gateway.call.result.isError).toBe(true);
  });

  it.each([1, 2])("offers no catalog at depth %s, where no folded tool is allowed", async (depth) => {
    const { list, call } = await probeWithIdentity(identity(depth), "find_wink_tool", { query: "routine bot image api credential" });
    expect(names(list).sort()).toEqual(["check_delegation", "list_bots", "update_task_state", "wait_delegation", "list_routines"].sort());
    expect(JSON.parse(call.result.content[0].text).tools).toEqual([]);
    const refused = await probeWithIdentity(identity(depth), "call_wink_tool", { name: "create_bot", arguments: { name: "X", role: "Y", instructions: "Z" } });
    expect(refused.call.result.isError).toBe(true);
  });

  it("keeps missing grants, unknown names and recursive calls closed", async () => {
    const missing = await probeWithIdentity({ OMB_WINK_TOOL_CATALOG: "1" }, "find_wink_tool", { query: "images" });
    expect(missing.list.result.tools).toEqual([]);
    expect(missing.call.error.code).toBe(-32602);
    for (const name of ["missing", "find_wink_tool", "call_wink_tool", "ask_user", "__proto__"]) {
      const { call } = await probeWithIdentity(identity(), "call_wink_tool", { name, arguments: {} });
      expect(call.result.isError).toBe(true);
    }
    const unauthorized = await probeWithIdentity({ ...identity(), OMB_COMMS_TOKEN: "wrong-token" }, "call_wink_tool", { name: "create_bot", arguments: { name: "Pixel", role: "Designer", instructions: "Draw things." } });
    expect(unauthorized.call.result.isError).toBe(true);
    expect(unauthorized.call.result.content[0].text).toContain("unauthorized");
  });
});

describe("agents-proxy verify_site", () => {
  let verifyProxy: string;
  let enabledRoot: string;
  const probe = (identity: Record<string, string>, name?: string, args?: unknown) => probeWithIdentity(identity, name, args, verifyProxy);
  beforeAll(async () => {
    const root = join(tmpdir(), "wink-LV-DONE-CHECK");
    mkdirSync(root, { recursive: true });
    enabledRoot = mkdtempSync(join(root, "proxy-"));
    verifyProxy = join(enabledRoot, "agents-proxy.mjs");
    await build({ entryPoints: [PROXY], outfile: verifyProxy, bundle: true, platform: "node", format: "esm" });
  });
  afterAll(() => rmSync(enabledRoot, { recursive: true, force: true }));

  it("ships the done-check for browser changes unless the user opts out", async () => {
    lastVerify = null;
    const { list, call } = await probeWithIdentity(identity(0, { OMB_LIVE_VERIFY: "1" }), "verify_site", { entry: "site" });
    expect(names(list)).toContain("verify_site");
    expect(call.error).toBeUndefined();
    expect(lastVerify).not.toBeNull();
  });

  it("describes every browser change in any folder", async () => {
    const { list } = await probe(identity(0, { OMB_LIVE_VERIFY: "1" }));
    const tool = list.result.tools.find((row: { name: string }) => row.name === "verify_site");
    expect(tool.description).toContain("every change that renders in a browser");
    expect(tool.description).toContain("unless the user says not to");
    expect(tool.description).toContain("any folder");
    expect(tool.inputSchema.properties.entry.description).toContain("loopback");
  });

  const identity = (depth: number, flags: Record<string, string>) => ({ OMB_BOT_ID: "bot-asker", OMB_THREAD_ID: "thread-asker-routine", OMB_COMMS_TOKEN: TOKEN, OMB_TURN_DEPTH: String(depth), OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`, ...flags });
  const names = (list: any): string[] => list.result.tools.map((t: { name: string }) => t.name);

  it("adds zero tools/list bytes on production turns", async () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const verify = await import("../verify-site.ts") as { verifyToolEnv?: (desktop: boolean, platform: NodeJS.Platform) => Record<string, string> };
    const { list } = await probe(identity(0, verify.verifyToolEnv?.(true, "win32") ?? {}));
    expect(names(list)).not.toContain("verify_site");
    expect(Buffer.byteLength(JSON.stringify(list.result.tools.filter((tool: { name: string }) => tool.name === "verify_site"))) - 2).toBe(0);
    expect(source.includes("verifyToolEnv")).toBe(false);
  });

  it.each<[Record<string, string>, number, boolean]>([
    [{ OMB_TEAM_REPORTS: "0" }, 19, false],
    [{ OMB_TEAM_REPORTS: "0", OMB_LIVE_VERIFY: "1" }, 20, true],
    [{ OMB_TEAM_REPORTS: "1" }, 20, false],
    [{ OMB_TEAM_REPORTS: "1", OMB_LIVE_VERIFY: "1" }, 21, true],
    [{ OMB_TEAM_REPORTS: "0", OMB_WINK_TOOL_CATALOG: "1" }, 16, false],
    [{ OMB_TEAM_REPORTS: "0", OMB_LIVE_VERIFY: "1", OMB_WINK_TOOL_CATALOG: "1" }, 17, true],
    [{ OMB_TEAM_REPORTS: "1", OMB_WINK_TOOL_CATALOG: "1" }, 17, false],
    [{ OMB_TEAM_REPORTS: "1", OMB_LIVE_VERIFY: "1", OMB_WINK_TOOL_CATALOG: "1" }, 18, true],
  ])("lists the tool only with its env (%o)", async (flags, total, listed) => {
    const { list } = await probe(identity(0, flags));
    expect(names(list)).toHaveLength(total);
    expect(names(list).includes("verify_site")).toBe(listed);
  });

  it.each<Record<string, string>>([{ OMB_TEAM_REPORTS: "0", OMB_LIVE_VERIFY: "1" }, { OMB_TEAM_REPORTS: "1", OMB_LIVE_VERIFY: "1" }, { OMB_TEAM_REPORTS: "1" }])("keeps the five peer tools and never lists verify_site at depth > 0 (%o)", async (flags) => {
    const { list, call } = await probe(identity(1, flags), "verify_site", { entry: "site" });
    expect(names(list).sort()).toEqual(["check_delegation", "list_bots", "list_routines", "update_task_state", "wait_delegation"]);
    expect(call.result?.isError ?? call.error).toBeTruthy();
  });

  it("refuses a direct peer call before calling the harness", async () => {
    lastVerify = null;
    const { call } = await probe(identity(1, { OMB_LIVE_VERIFY: "1" }), "verify_site", { entry: "site" });
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("unavailable in peer turns");
    expect(lastVerify).toBeNull();
  });

  it.each([
    [{ status: "completed", text: "Desktop and phone: no problems found." }, false],
    [{ status: "blocked", errorCode: "busy", text: "Live Verify could not finish site: another Live Verify run is going; try again when it finishes." }, true],
  ])("posts the entry with the bearer and returns the reply text (%o)", async (reply, isError) => {
    verifyResponse = reply;
    const { call } = await probe(identity(0, { OMB_LIVE_VERIFY: "1" }), "verify_site", { entry: "site", fromBotId: "bot-other" });
    expect(lastVerify).toEqual({ auth: `Bearer ${TOKEN}`, body: { entry: "site" } });
    expect(call.result.content[0].text).toBe(reply.text);
    expect(Boolean(call.result.isError)).toBe(isError);
  });

  it.each(["0", "1"])("preserves cancellation with catalog flag %s", async (catalog) => {
    lastVerify = null;
    const dropped = new Promise<boolean>((resolve) => (verifyHold = resolve));
    const proxy = spawn(process.execPath, [verifyProxy], { windowsHide: true, env: { ...process.env, ...identity(0, { OMB_LIVE_VERIFY: "1", OMB_WINK_TOOL_CATALOG: catalog }) }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    proxy.stdout!.on("data", (chunk) => (out += chunk));
    try {
      proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "verify_site", arguments: { entry: "site" } } }) + "\n");
      await vi.waitFor(() => expect(lastVerify).not.toBeNull(), { timeout: 10_000 });
      proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }) + "\n");
      expect(await dropped).toBe(true);
      proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }) + "\n");
      await vi.waitFor(() => expect(out).toContain('"id":8'), { timeout: 10_000 });
      expect(out).not.toContain('"id":7');
    } finally {
      verifyHold = null;
      proxy.kill();
    }
  });
});
