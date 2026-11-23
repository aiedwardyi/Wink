import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { VERIFY_ROUTES } from "../shared/live-verify.ts";
import { botRoute, CommsCallers } from "./comms-caller.ts";
import { webRead } from "./drivers/web-read-tool.ts";

it("keeps a stable token for each bot and session", () => {
  const callers = new CommsCallers();
  const token = callers.token("a", "home");
  expect(callers.token("a", "home")).toBe(token);
  expect(callers.token("a", "other")).not.toBe(token);
  expect(callers.resolve(`Bearer ${token}`)).toEqual({ botId: "a", threadId: "home" });
});

it("refuses unknown or malformed caller tokens", () => {
  const callers = new CommsCallers();
  expect(callers.resolve(undefined)).toBeUndefined();
  expect(callers.resolve(["Bearer forged"])).toBeUndefined();
  expect(callers.resolve("Bearer forged")).toBeUndefined();
});

it("lets a bot's own token reach every route its agents and terminal tools call and nothing else", () => {
  const drivers = new URL("./drivers/", import.meta.url);
  const tools = readdirSync(drivers).filter((file) => file.endsWith("-tool.ts") || file === "agents-proxy.ts" || file === "terminal-proxy.ts").map((file) => readFileSync(new URL(file, drivers), "utf8"));
  // Routes kept in shared constants (WEB_READ_ROUTE, VERIFY_ROUTES) live in the shared modules the tools import.
  const shared = [...new Set(tools.flatMap((source) => [...source.matchAll(/from "(\.\.\/\.\.\/shared\/[\w-]+\.ts)"/g)].map((m) => m[1]!)))].map((path) => readFileSync(new URL(path, drivers), "utf8"));
  const proxy = [...tools, ...shared].join("\n");
  const called = [...new Set([...proxy.matchAll(/["`}](\/api\/internal\/[\w/-]+)/g)].map((m) => m[1]!.replace(/\/$/, "/x")))];
  expect(called.length).toBeGreaterThan(15);
  for (const path of called) expect(botRoute(path, "b1"), `a bot tool calls ${path} with its own token: add it to BOT_ROUTE in server/comms-caller.ts`).toBe(true);
  for (const path of ["/api/internal/wake", VERIFY_ROUTES.tool, "/api/verify/runs/run-1234/live", "/api/bots/b1/map/repo"]) expect(botRoute(path, "b1"), path).toBe(true);
  for (const path of ["/api/internal/terminal-bridge", "/api/internal/google-account", "/api/phone/pairing", "/api/bots/b1", "/api/config", "/api/internal/agents/x", "/api/verify/runs/run-1234/decision", "/api/bots/b2/map/repo", "/api/bots/b1/map/repo/x", "/api/bots/b1/memory"]) {
    expect(botRoute(path, "b1"), path).toBe(false);
  }
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(index).toContain("return commsCallers.allows(header, path, bootToken);");
  expect(index).toContain("authorizedComms(req.headers.authorization, path)");
});

it("lets a busy bot's own token hand a room ask off", () => {
  expect(botRoute("/api/internal/hand-off", "b1")).toBe(true);
});

it("answers a bot's web_read through the real gate with the page, not 401", async () => {
  const callers = new CommsCallers();
  const header = `Bearer ${callers.token("b1", "home")}`;
  const page = { status: "ok", url: "https://example.com/", route: "fetch", tried: ["step 2 fetch: ok, 1,200 chars"], text: "Example Domain" };
  const api = async (path: string) => {
    if (!callers.allows(header, path, () => false)) throw new Error("unauthorized");
    return page;
  };
  const result = await webRead({ url: "https://example.com/" }, api, async () => ({}));
  expect(JSON.parse(result.text)).toMatchObject({ status: "ok", route: "fetch", text: "Example Domain" });
});
