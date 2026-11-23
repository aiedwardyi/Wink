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

  it("masks key-shaped values, says so, and keeps words like password and tokens", async () => {
    const key = "sk-proj-AbCdEf0123456789XyZ";
    expect(await call({ name: "Deploy", goal: `Use key ${key} for the deploy; add a password reset page; keep tokens under 400` })).toEqual({ status: 200, text: expect.stringContaining("1 part(s) masked as key-shaped") });
    const saved = readMemoryTopic(BOT, "decisions.md")!;
    expect(saved).not.toContain(key);
    expect(saved).toContain("add a password reset page; keep tokens under 400");
    expect(memorySystemPrompt(BOT)).not.toContain(key);
  });
  it("keeps paths, links, model ids, uuids and dashed names as written", async () => {
    const plain = [
      "Rest of the spec is in memory/glasses-v1-spec-1122.md",
      "Calls use gemini-2.5-flash-native-audio-preview-12-2025 until I say otherwise",
      "Spec lives at docs/plans/2026-11-22-glasses-v1-meeting-tool.md, build to it",
      "Ship https://github.com/acme/widgets/pull/2136 before the demo",
      "Branch fix/mem-goals-2136-budget-clip must merge first",
      "Use claude-3-5-sonnet-20241022 for the note-taker",
      "안경 v1 스펙은 docs/plans/2026-11-22-glasses-v1-meeting-tool.md 에 있다",
      "Keep commit 8efbc775d253643dbce1df9077f856f4c9951c32 as the red arm",
      "Thread 3f2c9a1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f holds the notes",
      "Docs at https://Example.com/Wink/Releases/2026-11-22-notes",
    ];
    for (const [i, goal] of plain.entries()) {
      const name = `Plain ${i} glasses-v1-spec-1122`;
      expect(await call({ name, goal })).toEqual({ status: 200, text: `Pinned the goal "${name}": it shows in every turn until it is done.` });
      expect(readMemoryTopic(BOT, "decisions.md")).toContain(goal);
      expect(memorySystemPrompt(BOT)).toContain(goal);
      removeWorkspaceDir(workspaceDir(BOT));
    }
  });

  it("still masks named key shapes and mixed-case key runs", async () => {
    const keys = ["sk-ant-api03-AbCdEfGh0123456789", "ghp_AbCdEfGhIjKlMnOpQrSt0123", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "AKIAIOSFODNN7EXAMPLE", "Xk9fQ2mZ7pL4vB8nR3tY6wE1aB", "memory/Xk9fQ2mZ7pL4vB8nR3tY6wE1", "https://acme.com/hook?t=Ab12Cd34Ef56Gh78Ij90Kl"];
    expect(await call({ name: "Keys", goal: `Deploy with ${keys.join(" and ")}` })).toEqual({ status: 200, text: expect.stringContaining(`${keys.length} part(s) masked as key-shaped`) });
    const saved = readMemoryTopic(BOT, "decisions.md")!;
    for (const key of keys) expect(saved).not.toContain(key.split(/[/?=]/).pop());
  });

  it("refuses a goal that is only a key", async () => {
    expect(await call({ name: "API key", goal: "sk-proj-AbCdEf0123456789XyZ0123456789" })).toEqual({ status: 400, text: expect.stringContaining("only key-shaped text") });
    expect(readMemoryTopic(BOT, "decisions.md")).toBeNull();
  });
});
