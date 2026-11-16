import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VERIFY_ROUTES } from "../shared/live-verify.ts";
import { botRoute, CommsCallers } from "./comms-caller.ts";

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
  const proxy = ["agents-proxy.ts", "terminal-proxy.ts"].map((file) => readFileSync(new URL(`./drivers/${file}`, import.meta.url), "utf8")).join("\n");
  const called = [...new Set([...proxy.matchAll(/["`}](\/api\/internal\/[\w/-]+)/g)].map((m) => m[1]!.replace(/\/$/, "/x")))];
  expect(called.length).toBeGreaterThan(15);
  for (const path of [...called, VERIFY_ROUTES.tool, "/api/verify/runs/run-1234/live", "/api/bots/b1/map/repo"]) expect(botRoute(path, "b1"), path).toBe(true);
  for (const path of ["/api/internal/terminal-bridge", "/api/internal/google-account", "/api/phone/pairing", "/api/bots/b1", "/api/config", "/api/internal/agents/x", "/api/verify/runs/run-1234/decision", "/api/bots/b2/map/repo", "/api/bots/b1/map/repo/x", "/api/bots/b1/memory"]) {
    expect(botRoute(path, "b1"), path).toBe(false);
  }
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(index).toContain("return caller ? botRoute(path, caller.botId) : bootToken(header);");
  expect(index).toContain("authorizedComms(req.headers.authorization, path)");
});
