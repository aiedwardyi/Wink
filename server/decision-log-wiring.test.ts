// The decision log is only as good as its wiring: every row is written at
// the request.opened fold or in answerRequest, and both of those keep
// working (cards keep appearing, approvals keep flowing) even when the
// logging silently rots away.
// these run the real server against the fake ACP CLI and assert the ROWS,
// not the behavior the rows describe:
//
//   1. a rule-matched auto-approval writes a row naming the rule
//   2. a card and the human's answer write two rows (allow and deny)
//   3. an answer that could not be delivered writes NO approval row
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDecisions, type DecisionRow } from "./decision-log.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

/** Newest matching decision row, or null when none shows up in time. */
async function waitForDecision(pred: (r: DecisionRow) => boolean, ms = 30_000): Promise<DecisionRow | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = readDecisions(join(home, ".orbit"), Number.MAX_SAFE_INTEGER);
    const row = rows.filter(pred).at(-1);
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A live permission card on a bot's transcript (via /api/bots — the same
 * poll unattended.test.ts uses, since a bot's card lives on its thread). */
async function waitForBotCard(botId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/bots");
    const bot = (body.bots ?? []).find((b: { id: string }) => b.id === botId);
    const card = bot?.messages?.find(
      (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
        m.kind === "options" && m.card?.requestId && !m.card.answered,
    );
    if (card) return card;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** A bot whose fake engine asks permission to run `echo hi` (the ACP core
 * folds that to tool "shell", summary "echo hi" — so the always-allow key
 * is "shell:echo"). */
async function makePermissionBot(patch: Record<string, unknown>, instanceId = "grok") {
  const created = await api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  const patched = await api("PATCH", `/api/bots/${bot.id}`, {
    autoApprove: false,
    ...patch,
    modelSelection: { instanceId, model: "fake-model" },
  });
  expect(patched.status).toBe(200);
  return patched.body.bot ?? bot;
}

posixOnly("authorization decisions are logged", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-decisions-e2e-"));
    mkdirSync(join(home, ".orbit"), { recursive: true });
    writeFileSync(
      join(home, ".orbit", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          grokPersistent: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_KINDS: "allow_always,reject_always" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "a rule-matched auto-approval writes a row naming the rule",
    async () => {
      const bot = await makePermissionBot({ name: "Granted", alwaysAllow: ["shell:echo"] });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const row = await waitForDecision((r) => r.decision === "auto-approved" && r.botId === bot.id);
      expect(row, "the auto-approval never reached the decision log").not.toBeNull();
      expect(row!.source).toBe("always-allow");
      expect(row!.rule).toBe("shell:echo");
      expect(row!.tool).toBe("shell");
      expect(row!.summary).toBe("echo hi");
      expect(row!.botName).toBe("Granted");
      expect(row!.threadId).toBeTruthy();
      expect(row!.requestId).toBeTruthy();
    },
    60_000,
  );

  it(
    "a card and the human's allow write two rows",
    async () => {
      const bot = await makePermissionBot({ name: "Askme" });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card, "no approval card ever appeared").not.toBeNull();
      const requestId = card.card.requestId as string;

      const shown = await waitForDecision((r) => r.decision === "card-shown" && r.requestId === requestId);
      expect(shown, "the card was shown but never logged").not.toBeNull();
      expect(shown!.source).toBe("no-grant");
      expect(shown!.botId).toBe(bot.id);
      expect(shown!.tool).toBe("shell");

      const answered = await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "allow" });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).not.toBe("unavailable");

      const user = await waitForDecision((r) => r.decision === "user-approved" && r.requestId === requestId);
      expect(user, "the human's answer never reached the decision log").not.toBeNull();
      expect(user!.source).toBe("user");
      expect(user!.tool).toBe("shell");
      expect(user!.summary).toBe("echo hi");
      expect(user!.botName).toBe("Askme");
    },
    90_000,
  );

  it(
    "a human deny writes its row too",
    async () => {
      const bot = await makePermissionBot({ name: "Refused" });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card).not.toBeNull();
      const requestId = card.card.requestId as string;
      expect((await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "deny" })).status).toBe(200);

      const user = await waitForDecision((r) => r.decision === "user-denied" && r.requestId === requestId);
      expect(user, "the denial never reached the decision log").not.toBeNull();
      expect(user!.source).toBe("user");
    },
    90_000,
  );

  it(
    "an allow the agent left no way to deliver writes no approval row",
    async () => {
      // This agent advertises allow_always but no allow_once, so the driver
      // cancels rather than take a grant it could never revoke. The human
      // still pressed Allow, and that is exactly the trap: the row would say
      // they approved a command that never ran.
      const bot = await makePermissionBot({ name: "Onlypersistent" }, "grokPersistent");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card, "no approval card ever appeared").not.toBeNull();
      // SAFETY: waitForBotCard only matches a message whose card carries a requestId.
      const requestId = card.card.requestId as string;
      // the card row proving the log itself is alive, so the absence below means
      // "not written" rather than "logging broken"
      expect(await waitForDecision((r) => r.decision === "card-shown" && r.requestId === requestId)).not.toBeNull();

      const answered = await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "allow" });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).toBe("unavailable");

      const approved = await waitForDecision((r) => r.decision === "user-approved" && r.requestId === requestId, 5_000);
      expect(approved, "an approval was logged for a command that never ran").toBeNull();
    },
    90_000,
  );
});
