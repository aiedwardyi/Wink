import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MspMuseAgentDriver, MSP_MUSE_EFFORT_LEVELS, MSP_MUSE_MODELS, museDirectHost, museServeArgs } from "./muse.ts";
import { classifyMuseError, museDefaultCli } from "../acp/muse.ts";
import { setWslGateForTests } from "../../wsl-gate.ts";
import { defaultModelEffort } from "../../../shared/model-effort.ts";
import { fakeMuseInstall, museReleaseInfo } from "../../testing/fake-muse-install.ts";

describe("classifyMuseError MSP turn errors", () => {
  it("maps authRequired to invalid_credentials, leaves the rest generic", () => {
    expect(classifyMuseError({ kind: "authRequired", message: "login expired" })).toBe("invalid_credentials");
    expect(classifyMuseError({ kind: "modelError", message: "boom" })).toBeUndefined();
  });

  it("keeps the ACP envelope behavior unchanged", () => {
    expect(classifyMuseError({ code: "AUTH_REQUIRED" })).toBe("invalid_credentials");
    expect(classifyMuseError({ code: "QUOTA_EXCEEDED" })).toBe("quota_or_region_restriction");
    expect(classifyMuseError({ code: -32601 })).toBeUndefined();
  });
});

describe("museServeArgs", () => {
  const off = ["-c", "run.reminder_roster.agents=[]"];

  it("turns the reminder agents off from 1.4.15 on a native CLI", () => {
    expect(museServeArgs("Muse Code 1.4.15 (1.4.15-R8339.1)", false)).toEqual(off);
    expect(museServeArgs("Muse Code 1.5.0 (1.5.0-R1.1)", false)).toEqual(off);
    expect(museServeArgs("Muse Code 2.0.1", false)).toEqual(off);
  });

  it("leaves older, unknown and WSL CLIs on a plain serve", () => {
    expect(museServeArgs("Muse Code 1.4.14 (1.4.14-R7309.1)", false)).toEqual([]);
    expect(museServeArgs("Muse Code 1.3.20", false)).toEqual([]);
    expect(museServeArgs("", false)).toEqual([]);
    expect(museServeArgs(null, false)).toEqual([]);
    expect(museServeArgs("Muse Code 1.4.15 (1.4.15-R8339.1)", true)).toEqual([]);
  });
});

describe.runIf(process.platform === "win32")("museDirectHost (launcher mirror)", () => {
  const now = Date.now();
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-muse-launcher-"));
    return { dir, ...fakeMuseInstall(dir, "unused.js") };
  };
  const checkedAt = (dir: string, seconds: number) => writeFileSync(join(dir, ".muse-update-checked-at"), `${seconds}\n`);

  it("names the active exe and hands it the launcher's env", () => {
    const { dir, cli, exe } = setup();
    expect(museDirectHost(cli, { PATH: "p" }, now)).toEqual({
      command: exe,
      env: { PATH: "p", PSExecutionPolicyPreference: "Bypass", MUSE_RELEASE_INFO: readFileSync(join(dir, ".muse-release-info.json"), "utf8") },
    });
  });

  it("drops release info that names another build, like the launcher", () => {
    const { dir, cli } = setup();
    writeFileSync(join(dir, ".muse-release-info.json"), museReleaseInfo("1.4.17-R1.1"));
    expect(museDirectHost(cli, { MUSE_RELEASE_INFO: "stale" }, now)?.env).not.toHaveProperty("MUSE_RELEASE_INFO");
  });

  it.each<[string, Record<string, string>, (dir: string) => void]>([
    ["an update check is due", {}, (dir) => checkedAt(dir, 0)],
    ["the check time is unreadable", {}, (dir) => writeFileSync(join(dir, ".muse-update-checked-at"), "soon\n")],
    ["a sync update is asked for", { MUSE_SYNC_UPDATE: "1" }, () => {}],
    ["the channel switches", { MUSE_CHANNEL: "muse-canary" }, () => {}],
    ["the channel is unsupported", { MUSE_CHANNEL: "nightly" }, () => {}],
    ["the version is malformed", {}, (dir) => writeFileSync(join(dir, ".muse-version"), "latest\n")],
    ["an install is running", { MUSE_LAUNCHER_INSTALL: "1" }, () => {}],
  ])("keeps the launcher when %s", (_, env, edit) => {
    const { dir, cli } = setup();
    edit(dir);
    expect(museDirectHost(cli, env, now)).toBeNull();
  });

  it("follows the update interval and the auto-update switch", () => {
    const { dir, cli, exe } = setup();
    checkedAt(dir, Math.floor(now / 1000) - 10);
    expect(museDirectHost(cli, {}, now)?.command).toBe(exe);
    expect(museDirectHost(cli, { MUSE_UPDATE_INTERVAL_SECONDS: "5" }, now)).toBeNull();
    checkedAt(dir, 0);
    expect(museDirectHost(cli, { MUSE_NO_AUTO_UPDATE: "1" }, now)?.command).toBe(exe);
  });

  it("leaves a CLI that is not the Muse launcher alone", () => {
    expect(museDirectHost(process.execPath, {}, now)).toBeNull();
  });
});

describe("MSP Muse driver", () => {
  it("offers sign-in and frees a signed-out thread before completion", async () => {
    setWslGateForTests({ env: { ORBIT_NO_WSL: "1" } });
    const home = mkdtempSync(join(tmpdir(), "omb-muse-signed-out-"));
    const instance = await MspMuseAgentDriver.create({
      instanceId: "muse-signed-out",
      displayName: "Muse",
      enabled: true,
      environment: {
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
        MUSE_AUTH_PATH: join(home, "auth.json"), META_API_KEY: "", ORBIT_NO_WSL: "1",
      },
      config: { cli: "missing-muse-cli", fullAuto: false },
    });
    const errors: unknown[] = [];
    const busyAtCompletion: boolean[] = [];
    instance.adapter.onEvent((event) => {
      if (event.type === "runtime.error") errors.push(event);
      if (event.type === "turn.completed") busyAtCompletion.push(instance.adapter.hasSession("signed-out"));
    });
    try {
      await instance.adapter.sendTurn({ threadId: "signed-out", text: "say hi", cwd: home });
      expect(busyAtCompletion).toEqual([false]);
      expect(errors).toContainEqual(expect.objectContaining({ signIn: true, message: expect.stringContaining("muse login") }));
      await instance.adapter.sendTurn({ threadId: "signed-out", text: "say hi again", cwd: home });
      expect(busyAtCompletion).toEqual([false, false]);
    } finally {
      await instance.dispose();
      setWslGateForTests(null);
    }
  });

  it("ships the four live model/list models with the 1.3 default", () => {
    expect(MSP_MUSE_MODELS.default).toBe("muse-spark-1.3");
    expect(MSP_MUSE_MODELS.options.map((o) => o.id)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
    ]);
    expect(MspMuseAgentDriver.models).toEqual(MSP_MUSE_MODELS);
  });

  it("registers behind the same museAgent kind the fleet keys on", () => {
    expect(MspMuseAgentDriver.driverKind).toBe("museAgent");
    expect(MspMuseAgentDriver.metadata.displayName).toBe("Meta Muse");
  });

  it("decodes the shared instance config with the platform CLI default", () => {
    expect(MspMuseAgentDriver.decodeConfig({}).cli).toBe(museDefaultCli());
    expect(MspMuseAgentDriver.decodeConfig({ cli: "custom-muse", fullAuto: true })).toMatchObject({
      cli: "custom-muse",
      fullAuto: true,
    });
    expect(MspMuseAgentDriver.defaultConfig().cli).toBe(museDefaultCli());
  });

  it("advertises the six CLI /effort tiers", async () => {
    expect([...MSP_MUSE_EFFORT_LEVELS]).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    const instance = await MspMuseAgentDriver.create({
      instanceId: "msp-effort-caps",
      displayName: "MSP Effort",
      environment: {},
      enabled: true,
      config: { cli: "missing-muse-cli", fullAuto: false },
    });
    try {
      expect(instance.adapter.capabilities.effortLevels).toEqual([...MSP_MUSE_EFFORT_LEVELS]);
    } finally {
      await instance.dispose();
    }
  });

  it("leaves the Muse default unset so the CLI keeps its own (high)", () => {
    for (const model of ["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2"]) {
      expect(defaultModelEffort("museAgent", model, [...MSP_MUSE_EFFORT_LEVELS])).toBeUndefined();
    }
    expect(defaultModelEffort("claudeAgent", "claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"])).toBe(
      "high",
    );
  });

  it("gates turns on the ambient login, not a stored-file probe alone", async () => {
    const offline = await MspMuseAgentDriver.create({
      instanceId: "msp-auth-off",
      displayName: "MSP Auth",
      environment: {},
      enabled: true,
      config: { cli: "missing-muse-cli", fullAuto: false },
    });
    expect(await offline.snapshot()).toMatchObject({ state: "unavailable" });
    await offline.dispose();
  });
});
