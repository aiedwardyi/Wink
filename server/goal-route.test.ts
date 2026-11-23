import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { goalRoute } from "./goal-route.ts";
import { removeWorkspaceDir, workspaceDir, memorySystemPrompt, readMemoryTopic } from "./workspace.ts";

const BOT = "goal-route-bot";

async function call(body: object, ownerTurn = true) {
  let status = 0;
  let raw = "";
  const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { headers: { authorization: "Bearer t" } }) as unknown as IncomingMessage;
  await goalRoute(req, res, { caller: () => ({ botId: BOT, threadId: "t1" }), ownerTurn: () => ownerTurn });
  return { status, text: String(JSON.parse(raw).text ?? JSON.parse(raw).error) };
}

afterEach(() => removeWorkspaceDir(workspaceDir(BOT)));

describe("pin_goal route", () => {
  it("pins only from the owner's own chat mid-turn", async () => {
    expect(await call({ name: "Glasses v1", goal: "person brief" }, false)).toEqual({ status: 403, text: "pin_goal works only in the user's own chat with you" });
    expect(await call({ name: "Glasses v1", done: true }, false)).toMatchObject({ status: 403 });
    expect(readMemoryTopic(BOT, "decisions.md")).toBeNull();
    expect(await call({ name: "Glasses v1", goal: "person brief" })).toMatchObject({ status: 200, text: expect.stringContaining("Pinned") });
  });

  it("refuses a goal over 4,000 characters and says what to do", async () => {
    expect(await call({ name: "Spec", goal: "x".repeat(4_001) })).toEqual({ status: 400, text: expect.stringContaining("over 4000. Pin the spec in the user's words in under 4000") });
    expect(await call({ name: "Spec", goal: "x".repeat(4_000) })).toMatchObject({ status: 200 });
  });

  it("masks key-shaped values and keeps words like password and tokens", async () => {
    const key = "sk-proj-AbCdEf0123456789XyZ";
    expect(await call({ name: "Deploy", goal: `Use key ${key} for the deploy; add a password reset page; keep tokens under 400` })).toMatchObject({ status: 200 });
    const saved = readMemoryTopic(BOT, "decisions.md")!;
    expect(saved).not.toContain(key);
    expect(saved).toContain("add a password reset page; keep tokens under 400");
    expect(memorySystemPrompt(BOT)).not.toContain(key);
  });
});
