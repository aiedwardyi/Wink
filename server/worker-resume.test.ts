import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AccountService } from "./accounts.ts";
import type { AccountContext } from "./account-policy.ts";
import { DATA_DIR } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { createResumeAccount, RESUME_NUDGE, resumeArgs, type WorkerResume } from "./worker-resume.ts";

const ID = "00000000-0000-4000-8000-000000000001";
type ResumeInstance = { enabled: boolean; driverKind: string; account?: AccountContext };
let serial = 0;

async function fixture() {
  const bases: InstanceConfigMap = { codex: { driver: "codex", environment: { CODEX_HOME: join(DATA_DIR, "base") } } };
  const accounts = new AccountService(join(DATA_DIR, `resume-${++serial}`), () => bases);
  const pending = await accounts.add("codex");
  const account = await accounts.identify(pending.id, "identity");
  const snapshot = { state: "available", authenticated: true };
  const live: ResumeInstance = { enabled: true, driverKind: "codex", account };
  const registry = { describeCached: vi.fn(async () => [{ instanceId: account.id, snapshot }]), get: vi.fn(() => live), accountAvailable: vi.fn(() => true) };
  const resolve = createResumeAccount(registry, accounts, () => bases);
  return { accounts, account, registry, snapshot, live, resolve };
}

describe("resume account admission", () => {
  it("resolves only the ready captured generation", async () => {
    const f = await fixture();
    expect(await f.resolve(f.account.id, f.account.generation)).toBe(f.accounts.get(f.account.id));
    expect(await f.resolve(f.account.id, f.account.generation + 1)).toBeUndefined();
  });

  it("rejects a signed-out account without selecting another account", async () => {
    const f = await fixture();
    f.snapshot.authenticated = false;
    expect(await f.resolve(f.account.id, f.account.generation)).toBeUndefined();
  });

  it("rebuilds a ready base account from current configuration and rejects it when signed out", async () => {
    const f = await fixture();
    f.live.account = undefined;
    f.registry.describeCached.mockResolvedValue([{ instanceId: "codex", snapshot: f.snapshot }]);
    expect(await f.resolve("codex", 0)).toMatchObject({ id: "codex", generation: 0, home: join(DATA_DIR, "base") });
    f.snapshot.authenticated = false;
    expect(await f.resolve("codex", 0)).toBeUndefined();
  });

  it("rejects a draining account even while its last probe is authenticated", async () => {
    const f = await fixture();
    await f.accounts.drain(f.account.id, "codex");
    expect(await f.resolve(f.account.id, f.account.generation)).toBeUndefined();
  });

  it("rejects stopped and blocked accounts", async () => {
    const f = await fixture();
    f.registry.accountAvailable.mockReturnValue(false);
    expect(await f.resolve(f.account.id, f.account.generation)).toBeUndefined();
    f.registry.accountAvailable.mockReturnValue(true);
    await f.accounts.stop(f.account.id);
    expect(await f.resolve(f.account.id, f.account.generation)).toBeUndefined();
  });
});

describe("resume argv", () => {
  it.each(["claude", "codex"] as const)("keeps %s flags and replaces the prompt with the exact nudge", (engine) => {
    const resume: WorkerResume = { engine, nativeId: ID, accountId: engine, accountGeneration: 0,
      template: { executable: engine, args: ["--model=fixture", ...(engine === "claude" ? ["--session-id=old", "--effort", "high", "--continue", "--fork-session"] : ["-c", "model_reasoning_effort=high", "--last"]), "old prompt"] } };
    const args = resumeArgs(resume);
    expect(args).toEqual(engine === "claude" ? ["--model=fixture", "--effort", "high", "-r", ID, RESUME_NUDGE]
      : ["resume", ID, "--model=fixture", "-c", "model_reasoning_effort=high", RESUME_NUDGE]);
  });

  it("replaces a previous exact selector and preserves grant placeholders", () => {
    const args = resumeArgs({ engine: "codex", nativeId: ID, accountId: "codex", accountGeneration: 0,
      template: { executable: "codex", args: ["resume", "old-id", "-c", "shell_environment_policy.set.ORBIT_MSG_AUTH='\u0000ORBIT_MSG_AUTH\u0000'", "old nudge"] } });
    expect(args).toEqual(["resume", ID, "-c", "shell_environment_policy.set.ORBIT_MSG_AUTH='\u0000ORBIT_MSG_AUTH\u0000'", RESUME_NUDGE]);
  });

  it("rejects invalid identities and unknown flags instead of guessing their arity", () => {
    const resume: WorkerResume = { engine: "claude", nativeId: ID, accountId: "claude", accountGeneration: 0, template: { executable: "claude", args: ["--unknown", "value", "task"] } };
    expect(() => resumeArgs(resume)).toThrow("Unsupported");
    expect(() => resumeArgs({ ...resume, nativeId: "latest" })).toThrow("identity");
    expect(() => resumeArgs({ ...resume, template: { executable: "codex", args: [] } })).toThrow("identity");
    expect(() => resumeArgs({ ...resume, template: { executable: "claude", args: ["first positional", "second positional"] } })).toThrow("Ambiguous");
  });
});
