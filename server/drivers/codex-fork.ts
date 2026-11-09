// Read-only fork of a thread's Codex session for the quick helper: a side
// app-server forks the saved thread ephemerally, so nothing is written for it,
// answers one turn, and every approval request is declined.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SideEvent, SideHandle, SideInput } from "../contracts.ts";
import { spawnCli } from "../procs.ts";
import { retireAppServer } from "./codex-catalog.ts";

export interface CodexSpawn {
  cli: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  policy: Pick<Parameters<typeof spawnCli>[2], "account" | "accountDriver" | "accountBaseHome">;
  /** the account home the app-server's state runtime lives in */
  home: string;
  /** the main thread's Codex thread id */
  cursor: string;
}

const QUIET_ITEMS = new Set(["agentMessage", "userMessage", "reasoning", "plan"]);

// The read-only sandbox and untrusted policy let only known-safe shell reads run unasked.
const toolName = (type: string) => (type === "commandExecution" ? "Read" : type);
const actions = (item: any): any[] => (Array.isArray(item?.commandActions) ? item.commandActions : []);

// Per the app-server protocol: legacy approvals say approved/denied, the rest accept/decline.
function decline(method: string): Record<string, unknown> {
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: "denied" };
  if (method === "mcpServer/elicitation/request") return { action: "decline" };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  return { decision: "decline" };
}

export function forkCodex(spawn: CodexSpawn, input: SideInput): SideHandle {
  const tempDir = mkdtempSync(join(tmpdir(), "omb-side-"));
  try {
    const child = spawnCli(spawn.cli, spawn.args, { ...spawn.policy, cwd: spawn.cwd, env: spawn.env, stdio: ["pipe", "pipe", "pipe"] });
    const live: SideHandle["live"] = { pid: child.pid ?? 0, procStart: Date.now(), cwd: spawn.cwd, tempDir };
    const listeners = new Set<(event: SideEvent) => void>();
    const emit = (event: SideEvent) => {
      for (const listener of listeners) listener(event);
    };
    let finished = false;
    let streamed = "";
    let answer = "";
    const used = { input: 0, output: 0, cachedInput: 0 };
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      emit({ type: "done", ok, text: answer || streamed, usage: used.input || used.output ? used : undefined });
    };
    const exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });

    let nextId = 1;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const send = (obj: object) => {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch {}
    };
    const request = (method: string, params: object) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });

    const onServerRequest = (msg: any) => {
      send({ jsonrpc: "2.0", id: msg.id, result: decline(String(msg.method)) });
      emit({ type: "tool", name: "approval" });
    };
    const onNotification = (msg: any) => {
      const p = msg.params ?? {};
      if (msg.method === "item/agentMessage/delta") {
        const delta = typeof p.delta === "string" ? p.delta : "";
        if (!delta) return;
        streamed += delta;
        emit({ type: "text", delta });
      } else if (msg.method === "item/started" && typeof p.item?.type === "string" && !QUIET_ITEMS.has(p.item.type)) {
        const reads = actions(p.item).filter((action) => action?.type === "read" && typeof action.path === "string");
        if (!reads.length) emit({ type: "tool", name: toolName(p.item.type) });
        for (const action of reads) emit({ type: "tool", name: "Read", path: action.path });
      } else if (msg.method === "item/completed" && p.item?.type === "commandExecution") {
        const scopes = actions(p.item).filter((action) => action?.type === "search" || action?.type === "listFiles");
        const text: string = typeof p.item.aggregatedOutput === "string" ? p.item.aggregatedOutput : "";
        if (!scopes.length || p.item.exitCode || !text.trim()) return;
        // like claude-fork's Grep/Glob: the scope counts, plus each "path:line:text" or path line
        const paths = text.split(/\r?\n/).map((line) => line.replace(/^((?:[a-zA-Z]:)?[^:]*).*$/, "$1")).filter(Boolean);
        emit({ type: "found", paths: [...scopes.map((action) => (typeof action.path === "string" ? action.path : "")), ...paths].filter(Boolean) });
      } else if (msg.method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string") {
        if (p.item.phase !== "commentary") answer = p.item.text;
        if (!streamed) emit({ type: "text", delta: p.item.text });
      } else if (msg.method === "thread/tokenUsage/updated" && p.tokenUsage?.last) {
        const { inputTokens, cachedInputTokens, outputTokens } = p.tokenUsage.last;
        used.input += inputTokens || 0;
        used.cachedInput += cachedInputTokens || 0;
        used.output += outputTokens || 0;
      } else if (msg.method === "turn/completed") {
        finish(p.turn?.status === "completed");
      }
    };
    const onLine = (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const waiting = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) waiting?.reject(new Error(msg.error.message ?? "app-server error"));
        else waiting?.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) onServerRequest(msg);
      else if (msg.method) onNotification(msg);
    };
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.resume();
    child.on("error", () => finish(false));
    child.on("close", () => finish(false));

    void (async () => {
      try {
        await request("initialize", { clientInfo: { name: "openmausbot", version: "1" } });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        const forked = await request("thread/fork", {
          threadId: spawn.cursor,
          ephemeral: true,
          excludeTurns: true,
          sandbox: "read-only",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
        });
        const id = forked?.thread?.id;
        if (typeof id !== "string") throw new Error("thread/fork returned no thread");
        emit({ type: "session", id });
        await request("turn/start", { threadId: id, input: [{ type: "text", text: [input.live, input.text].filter(Boolean).join("\n\n") }] });
      } catch {
        finish(false);
      }
    })();

    let closing: Promise<void> | null = null;
    return {
      live,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      // The app-server never exits on its own, and the ask is already answered: no grace.
      close: () =>
        (closing ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            retireAppServer(child, spawn.home);
            await exited;
          }
          rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        })()),
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
