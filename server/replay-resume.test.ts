// A phone that comes back after busy workers resumes from the replay ring
// instead of refetching every transcript, as long as what it missed fits.
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { openSse } from "./testing/sse.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";
const origin = () => `http://127.0.0.1:${port}`;

const api = async (method: "POST" | "PATCH", path: string, body: unknown) => {
  const res = await fetch(`${origin()}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = createFixtureHome("omb-replay-resume-");
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1) },
    windowsHide: true,
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${origin()}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  removeTestData(home);
});

describe("resume after busy workers", () => {
  it("replays the newest state of each bot rather than asking for a snapshot", async () => {
    const created = async (name: string) => {
      const { status, body } = await api("POST", "/api/bots", { name });
      expect(status).toBe(201);
      return (body as { bot: { id: string } }).bot;
    };
    const ada = await created("Ada");
    const bea = await created("Bea");
    const first = await openSse(`${origin()}/api/events`);
    const cursor = (await first.until((frame) => frame.kind === "hello")).cursor;
    first.close();

    // more bot frames than the ring holds, as working bots send while the phone sleeps
    for (let turn = 0; turn < 300; turn++) {
      expect((await api("PATCH", `/api/bots/${ada.id}`, { pinned: turn % 2 === 0 })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bea.id}`, { color: turn % 2 ? "#336699" : "#993366" })).status).toBe(200);
    }
    expect((await api("PATCH", `/api/bots/${ada.id}`, { color: "#112233" })).status).toBe(200);

    const back = await openSse(`${origin()}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      expect(await back.until((frame) => frame.kind === "hello")).toMatchObject({ resumed: true });
      await back.until((frame) => frame.kind === "bot" && frame.bot.id === ada.id && frame.bot.color === "#112233");
      const bots = back.frames.filter((frame) => frame.kind === "bot");
      const last = (id: string) => bots.filter((frame) => frame.bot.id === id).at(-1)!.bot;
      expect(last(ada.id)).toMatchObject({ pinned: false, color: "#112233" });
      expect(last(bea.id)).toMatchObject({ color: "#336699" });
      const seqs = back.frames.slice(1).map((frame) => frame.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally {
      back.close();
    }
  }, 60_000);

  it("replays a bot made while away before anything in its chat", async () => {
    const first = await openSse(`${origin()}/api/events`);
    const cursor = (await first.until((frame) => frame.kind === "hello")).cursor;
    first.close();
    const { status, body } = await api("POST", "/api/bots", { name: "Cy" });
    expect(status).toBe(201);
    const cy = (body as { bot: { id: string; threadId: string } }).bot;
    expect((await api("PATCH", `/api/bots/${cy.id}`, { color: "#445566" })).status).toBe(200);

    const back = await openSse(`${origin()}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      expect(await back.until((frame) => frame.kind === "hello")).toMatchObject({ resumed: true });
      await back.until((frame) => frame.kind === "bot" && frame.bot.id === cy.id && frame.bot.color === "#445566");
      const about = back.frames.filter((frame) => frame.bot?.id === cy.id || frame.threadId === cy.threadId);
      expect(about.some((frame) => frame.kind === "message")).toBe(true);
      expect(about[0].kind).toBe("bot");
    } finally {
      back.close();
    }
  }, 60_000);
});
