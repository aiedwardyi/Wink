#!/usr/bin/env node
// Fake of the codex CLI's `app-server` JSON-RPC surface, for driver
// tests. Speaks newline-delimited JSON-RPC on stdio: answers the
// initialize/thread/turn handshake, then plays a scripted turn. Like the
// real app-server, it never exits on its own — the driver kills it.
//
//   FAKE_CODEX_MODE   happy (default) | approval | resume | stream | windows-command |
//                     mcp-elicitation | logged-in-stdout | logged-out | unauthorized
//                     | bench-quiet (no tool items — latency floor)
//                     | usage-calls (two model calls: `last` per call, `total` the thread)
//                     | approval-pair (two approvals in one stdout chunk, then exits)
//   FAKE_CODEX_DUMP   path to write {argv, env, calls, decision} as JSON
//   FAKE_CODEX_USAGE  JSON array of tokenUsage payloads, one
//                     thread/tokenUsage/updated per model call of the turn
//   FAKE_CODEX_USAGE_REPLAY  JSON tokenUsage the app-server replays after
//                     thread/resume, stamped with an earlier turn's id
//   FAKE_CODEX_MESSAGES  JSON array of {text, phase?}: the turn's agentMessage
//                     items, in place of the one default reply
//   FAKE_CODEX_NO_INJECT  thread/inject_items fails, like a CLI without it
//   FAKE_CODEX_CONFIG  JSON config that config/read answers
//   thread/fork answers a new thread id and echoes `ephemeral`; the params land in the dump's calls
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_CODEX_MODE ?? "happy";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.147.0\n");
  process.exit(0);
}
if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (mode === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  // Codex 0.147.0 reports a successful login on stderr; retain a mode for
  // older versions that wrote the same status on stdout.
  const statusStream = mode === "logged-in-stdout" ? process.stdout : process.stderr;
  statusStream.write("Logged in using ChatGPT\n");
  process.exit(0);
}
// startup-race script: the first FAKE_CODEX_EARLY_EXITS launches write
// FAKE_CODEX_EARLY_EXIT_MESSAGE to stderr and exit before initialize. The
// launch count lives in FAKE_CODEX_STATE, as with the transient script.
if (process.env.FAKE_CODEX_EARLY_EXITS && process.env.FAKE_CODEX_STATE) {
  let launched = 0;
  try {
    launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
  } catch {}
  writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
  if (launched < (Number(process.env.FAKE_CODEX_EARLY_EXITS) || 0)) {
    writeSync(2, `${process.env.FAKE_CODEX_EARLY_EXIT_MESSAGE ?? "boom"}\n`);
    process.exit(1);
  }
}
const calls: Array<{ method: string; params: unknown }> = [];
let decision: unknown = null;

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method: string, params: unknown) => out({ jsonrpc: "2.0", method, params });

const dump = () => {
  if (process.env.FAKE_CODEX_DUMP) {
    writeFileSync(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify({ argv: process.argv.slice(2), env: process.env, calls, decision }, null, 2),
    );
  }
};

const finishTurn = () => {
  // bench-quiet never started tool items (see turn/start), so there is
  // nothing to complete — a text-only fixture turn.
  if (process.env.FAKE_CODEX_TOOL_FIXTURE) {
    for (const frame of JSON.parse(readFileSync(process.env.FAKE_CODEX_TOOL_FIXTURE, "utf8"))) notify(frame.method, frame.params);
  } else if (mode !== "bench-quiet") {
    notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed" } });
    notify("item/completed", { item: { id: "w1", type: "webSearch", status: "completed" } });
  }
  if (mode === "stream") {
    // token deltas, then the whole message — the driver must not double-emit
    notify("item/agentMessage/delta", { itemId: "m1", delta: "done from " });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "fake codex" });
  }
  const messages = process.env.FAKE_CODEX_MESSAGES ? JSON.parse(process.env.FAKE_CODEX_MESSAGES) : [{ text: "done from fake codex" }];
  messages.forEach((message: object, i: number) => notify("item/completed", { item: { id: `m${i + 1}`, type: "agentMessage", ...message } }));
  if (process.env.FAKE_CODEX_USAGE) {
    // like the real app-server: one report per model call, each carrying
    // that call (`last`) and the running thread total
    for (const tokenUsage of JSON.parse(process.env.FAKE_CODEX_USAGE)) {
      notify("thread/tokenUsage/updated", { threadId: "codex-thread-1", turnId: "native-turn-1", tokenUsage });
    }
  } else if (mode === "usage-calls") {
    const call = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({ inputTokens, cachedInputTokens, outputTokens });
    notify("thread/tokenUsage/updated", {
      tokenUsage: { total: call(25_881, 11_008, 583), last: call(25_881, 11_008, 583), modelContextWindow: 258_400 },
    });
    notify("thread/tokenUsage/updated", {
      tokenUsage: { total: call(55_238, 36_352, 830), last: call(29_357, 25_344, 247), modelContextWindow: 258_400 },
    });
  } else {
    notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 7, cachedInputTokens: 4, outputTokens: 3 } } });
  }
  // ChatGPT-plan accounts get this alongside the token count; resetsAt is
  // epoch SECONDS on the wire
  if (process.env.FAKE_CODEX_RATE_LIMITS) {
    notify("account/rateLimits/updated", {
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_790_000_000 },
        secondary: { usedPercent: 76, windowDurationMins: 10_080, resetsAt: 1_790_172_800 },
      },
    });
  }
  dump();
  notify("turn/completed", { turn: { status: "completed" } });
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // response to our own server->client request (approval decision)
    if ((msg.id === 100 || msg.id === 101) && (msg.result !== undefined || msg.error !== undefined)) {
      decision = msg.result ?? { error: msg.error };
      finishTurn();
      continue;
    }

    if (msg.method) calls.push({ method: msg.method, params: msg.params ?? null });

    switch (msg.method) {
      case "initialize":
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        break;
      case "model/list":
        if (msg.params?.cursor === "page-2") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
                { id: "gpt-page-two", displayName: "GPT Page Two", hidden: false, isDefault: false },
              ],
              nextCursor: null,
            },
          });
        } else {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-fake-default", displayName: "GPT Fake Default", hidden: false, isDefault: true },
              ],
              nextCursor: "page-2",
            },
          });
        }
        break;
      case "account/read": {
        let apiKey = false;
        if (process.env.CODEX_HOME) {
          try { apiKey = JSON.parse(readFileSync(join(process.env.CODEX_HOME, "auth.json"), "utf8")).auth_mode === "apikey"; } catch {}
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { account: mode === "logged-out" ? null : apiKey ? { type: "apiKey" } : { type: "chatgpt", email: "fixture@example.test", planType: "pro" } } });
        break;
      }
      case "thread/resume":
        if (mode === "resume") {
          out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId } } });
          if (process.env.FAKE_CODEX_USAGE_REPLAY) {
            notify("thread/tokenUsage/updated", {
              threadId: msg.params?.threadId,
              turnId: "codex-turn-earlier",
              tokenUsage: JSON.parse(process.env.FAKE_CODEX_USAGE_REPLAY),
            });
          }
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no such thread" } });
        }
        break;
      case "thread/start":
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-thread-1" }, model: "fake-codex-model" } });
        break;
      case "config/read":
        out({ jsonrpc: "2.0", id: msg.id, result: { config: JSON.parse(process.env.FAKE_CODEX_CONFIG ?? "{}") } });
        break;
      case "thread/fork":
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-fork-1", ephemeral: msg.params?.ephemeral === true }, model: "fake-codex-model" } });
        break;
      case "thread/inject_items":
        out(process.env.FAKE_CODEX_NO_INJECT
          ? { jsonrpc: "2.0", id: msg.id, error: { code: Number(process.env.FAKE_CODEX_NO_INJECT) < 0 ? Number(process.env.FAKE_CODEX_NO_INJECT) : -32601, message: "injection failed" } }
          : { jsonrpc: "2.0", id: msg.id, result: {} });
        break;
      case "turn/steer": {
        if (mode === "steer-reject" || msg.params.expectedTurnId !== "native-turn-1") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "turn mismatch" } });
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { turnId: "native-turn-1" } });
        notify("item/agentMessage/delta", { delta: msg.params.input[0].text });
        setTimeout(finishTurn, 30);
        break;
      }
      case "turn/start": {
        if (mode === "unauthorized") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            },
          });
          break;
        }
        // transient-failure script for retry tests. FAKE_CODEX_TRANSIENTS is
        // how many launches fail transiently; the launch count lives in a
        // state FILE because child processes cannot mutate the parent's env.
        // FAKE_CODEX_PARTIAL_FAILS makes the FIRST failing turn stream a text
        // delta first, so the partial-output guard has something to see.
        if (process.env.FAKE_CODEX_TRANSIENTS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const quota = Number(process.env.FAKE_CODEX_TRANSIENTS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < quota) {
            if (process.env.FAKE_CODEX_PARTIAL_FAILS) {
              out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
              notify("item/agentMessage/delta", { itemId: "m1", delta: "half an answer" });
              notify("turn/completed", { turn: { status: "failed", error: { message: "provider overloaded, try again" } } });
              break;
            }
            out({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" },
            });
            // a retired attempt keeps talking until its kill lands
            if (process.env.FAKE_CODEX_LATE_COMPLETE) {
              const late = setInterval(() => notify("turn/completed", { turn: { status: "completed" } }), 5);
              setTimeout(() => clearInterval(late), 400);
            }
            break;
          }
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "native-turn-1" } } });
        notify("turn/started", { threadId: "codex-thread-1", turn: { id: "native-turn-1" } });
        if (mode.startsWith("steer")) {
          notify("item/agentMessage/delta", { delta: "working" });
          break;
        }
        const command = mode === "windows-command"
          ? [
              "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
              "-Command",
              `\"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'\"`,
            ].join(" ")
          : "ls -la";
        if (mode !== "bench-quiet" && !process.env.FAKE_CODEX_TOOL_FIXTURE) {
          notify("item/started", { item: { id: "i1", type: "commandExecution", command } });
          notify("item/started", { item: { id: "w1", type: "webSearch", query: "OpenMausBot" } });
        }
        if (mode === "mcp-elicitation") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "agents",
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
              message: 'Allow the agents MCP server to run tool "list_bots"?',
              requestedSchema: { type: "object", properties: {} },
            },
          });
        } else if (mode === "approval-pair") {
          const ask = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "execCommandApproval", params: { command: "rm -rf scratch" } });
          writeSync(1, `${ask(100)}\n${ask(101)}\n`);
          process.exit(0);
        } else if (mode === "approval" || mode === "windows-command") {
          const approvalCommand = mode === "windows-command" ? command : "rm -rf scratch";
          out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: approvalCommand } });
          // turn continues from the approval response handler above
        } else {
          finishTurn();
        }
        break;
      }
      default:
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});

// match the real app-server: stay alive until killed
setInterval(() => {}, 1_000);
