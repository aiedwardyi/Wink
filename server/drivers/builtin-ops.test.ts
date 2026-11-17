import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VERIFY_TOOL_ENV } from "../../shared/live-verify.ts";
import { askPreallowedOps, builtinOps, isSideEffectOp, opEffect } from "./builtin-ops.ts";
import { TOOLS as TERMINAL_TOOLS } from "./terminal-proxy.ts";
import { CATALOG_TOOLS } from "./tool-catalog.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function agentsProxyTools(): Promise<string[]> {
  for (const [key, value] of Object.entries({ OMB_BOT_ID: "b1", OMB_THREAD_ID: "t1", OMB_COMMS_TOKEN: "tok", OMB_TEAM_REPORTS: "1", OMB_OWNER_CHATS: "1", OMB_HAND_OFF: "1", [VERIFY_TOOL_ENV]: "1" })) vi.stubEnv(key, value);
  vi.resetModules();
  const { handle } = await import("./agents-proxy.ts");
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
  await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  return JSON.parse(lines[0]!).result.tools.map((tool: { name: string }) => tool.name);
}

function phoneProxyTools(): string[] {
  const proxy = fileURLToPath(new URL("./phone-proxy.ts", import.meta.url));
  const { stdout } = spawnSync(process.execPath, [proxy], { input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`, encoding: "utf8", windowsHide: true });
  return JSON.parse(stdout.split("\n")[0]!).result.tools.map((tool: { name: string }) => tool.name);
}

describe("built-in operation table", () => {
  it("classifies every tool the agents, phone and terminal proxies list", async () => {
    const listed = { agents: [...(await agentsProxyTools()), ...CATALOG_TOOLS.map((tool) => tool.name)], phone: phoneProxyTools(), terminal: TERMINAL_TOOLS.map((tool) => tool.name) };
    for (const [server, names] of Object.entries(listed)) {
      const unclassified = names.filter((name) => !Object.hasOwn(builtinOps(server) ?? {}, name));
      expect(unclassified, `add these ${server} tools to builtin-ops.ts`).toEqual([]);
    }
  });

  it("marks paid, key-backed, device and workspace-changing ops as side effects", () => {
    expect(opEffect("agents", "generate_image")).toBe("billing");
    expect(opEffect("agents", "call_api")).toBe("key");
    expect(opEffect("openmausbot_phone", "tap")).toBe("device");
    for (const tool of ["create_bot", "create_channel", "set_keep_going", "report_issue", "call_wink_tool"]) expect(isSideEffectOp("agents", tool), tool).toBe(true);
  });

  it("treats an unknown server or tool as a side effect", () => {
    expect(isSideEffectOp("agents", "brand_new_tool")).toBe(true);
    expect(isSideEffectOp("agents", undefined)).toBe(true);
    expect(isSideEffectOp("composio", "GMAIL_SEND_EMAIL")).toBe(true);
    expect(isSideEffectOp("browser", "browser_navigate")).toBe(true);
    expect(isSideEffectOp("agents", "toString")).toBe(true);
  });

  it("preallows in Ask only what reads or stays in the chat", () => {
    expect(askPreallowedOps("agents")).toEqual(expect.arrayContaining(["list_bots", "ask_user", "update_task_state", "ask_bot", "react", "show_image", "propose_routine", "wake_me"]));
    expect(askPreallowedOps("agents")).not.toEqual(expect.arrayContaining(["generate_image"]));
    expect(askPreallowedOps("phone").sort()).toEqual(["list_apps", "read_screen", "screenshot", "status"]);
    expect(askPreallowedOps("terminal").sort()).toEqual(["terminal_playbook", "terminal_read"]);
    expect(askPreallowedOps("browser")).toEqual([]);
  });
});
