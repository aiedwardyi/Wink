// execCli's --version cache. The fake CLI logs each launch to a file, so the
// counts are real process launches, not calls.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { constants, getPriority, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearVersionCache, describeSpawnFailure, execCli, setCliPriority, spawnCli } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let dir: string;
let script: string;
let log: string;
let cli: string;

function writeCli(version: string) {
  writeFileSync(
    script,
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + ";");\nconsole.log(${JSON.stringify(version)});\n`,
  );
}

function run(args: string[], env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) {
  return new Promise<string | null>((resolve) => {
    execCli(cli, args, { timeout: 10_000, env }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

const launches = () => readFileSync(log, "utf8").split(";").filter(Boolean);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "procs-version-"));
  script = join(dir, "fake-cli.cjs");
  log = join(dir, "launches.log");
  writeFileSync(log, "");
  cli = `"${process.execPath}" "${script}"`;
  writeCli("fake 1.0.0");
});

afterEach(() => removeTempDir(dir));

describe("execCli --version cache", () => {
  it("launches an unchanged binary once, while auth checks still launch every time", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await run(["--version"])).toBe("fake 1.0.0");
      await run(["auth", "status"]);
    }
    expect(launches()).toEqual(["--version", "auth status", "auth status", "auth status"]);
  });

  it("launches again once the binary changes", async () => {
    expect(await run(["--version"])).toBe("fake 1.0.0");
    writeCli("fake 2.0.0-next");
    expect(await run(["--version"])).toBe("fake 2.0.0-next");
    expect(await run(["--version"])).toBe("fake 2.0.0-next");
    expect(launches()).toEqual(["--version", "--version"]);
  });

  it("keys on the env, so a probe never answers with another env's output", async () => {
    await run(["--version"], { PATH: process.env.PATH, PROBE: "a" });
    await run(["--version"], { PATH: process.env.PATH, PROBE: "b" });
    expect(launches()).toEqual(["--version", "--version"]);
  });

  it("launches again when a same-size, same-mtime rewrite changes the ctime", async () => {
    const stamp = new Date("2026-10-01T00:00:00.000Z");
    writeCli("fake 1.0.0");
    utimesSync(script, stamp, stamp);
    expect(await run(["--version"])).toBe("fake 1.0.0");
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeCli("fake 2.0.0");
    utimesSync(script, stamp, stamp);
    expect(await run(["--version"])).toBe("fake 2.0.0");
    expect(launches()).toEqual(["--version", "--version"]);
  });

  it("launches again when a same-size, same-mtime replacement has a new inode", async () => {
    const stamp = new Date("2026-10-01T00:00:00.000Z");
    writeCli("fake 1.0.0");
    utimesSync(script, stamp, stamp);
    expect(await run(["--version"])).toBe("fake 1.0.0");
    const next = join(dir, "next.cjs");
    writeFileSync(next, readFileSync(script, "utf8").replace("1.0.0", "2.0.0"));
    utimesSync(next, stamp, stamp);
    renameSync(next, script);
    expect(await run(["--version"])).toBe("fake 2.0.0");
    expect(launches()).toEqual(["--version", "--version"]);
  });

  it("clearVersionCache makes the next check launch again", async () => {
    await run(["--version"]);
    await run(["--version"]);
    expect(launches()).toEqual(["--version"]);
    clearVersionCache();
    await run(["--version"]);
    expect(launches()).toEqual(["--version", "--version"]);
  });

  it("holds at most 64 versions", async () => {
    const envFor = (n: number) => ({ PATH: process.env.PATH, PROBE: String(n) });
    for (let n = 0; n < 65; n++) await run(["--version"], envFor(n));
    await run(["--version"], envFor(64));
    expect(launches()).toHaveLength(65);
    await run(["--version"], envFor(0));
    expect(launches()).toHaveLength(66);
  }, 60_000);

  it("never caches a failed probe", async () => {
    writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(log)}, "--version;");\nprocess.exit(1);\n`);
    expect(await run(["--version"])).toBeNull();
    expect(await run(["--version"])).toBeNull();
    expect(launches()).toEqual(["--version", "--version"]);
  });
});

describe("execCli env", () => {
  it("turns off agy's self-updater on Windows, whose console windowsHide can't hide", async () => {
    writeFileSync(script, "console.log(process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? \"unset\");\n");
    expect(await run(["-p", "/usage"])).toBe(process.platform === "win32" ? "true" : "unset");
  });

  it.runIf(process.platform === "win32")("gives a start with no PATHEXT the default one, so PowerShell launchers run an .exe in place", async () => {
    writeFileSync(script, "console.log(process.env.PATHEXT ?? \"unset\");\n");
    expect(await run(["-p", "/usage"])).toBe(".COM;.EXE;.BAT;.CMD");
    expect(await run(["-p", "/usage"], { PATH: process.env.PATH, PathExt: ".EXE" })).toBe(".EXE");
    const child = spawnCli(cli, [], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    await new Promise((resolve) => child.once("close", resolve));
    expect(out.trim()).toBe(".COM;.EXE;.BAT;.CMD");
  });
});

describe("spawnCli direct start", () => {
  const output = (child: ReturnType<typeof spawnCli>) => new Promise<string>((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("close", () => resolve(out.trim()));
  });
  const account = { id: "a1", of: "codex", home: join(tmpdir(), "omb-procs-account"), generation: 1 };

  it("runs the direct start with env set after the account policy", async () => {
    let seen: string[] = [];
    const child = spawnCli(cli, ["app-server"], {
      env: { PATH: process.env.PATH, CODEX_MANAGED_BY_NPM: "stripped" },
      stdio: ["pipe", "pipe", "pipe"],
      account,
      accountDriver: "codex",
      direct: (launch, env) => {
        seen = launch.args;
        return { command: process.execPath, args: ["-e", "console.log(process.env.CODEX_MANAGED_BY_NPM, process.env.CODEX_HOME)"], env: { ...env, CODEX_MANAGED_BY_NPM: "1" } };
      },
    });
    expect(await output(child)).toBe(`1 ${account.home}`);
    expect(seen.slice(0, 2)).toEqual([script, "app-server"]);
    expect(seen).toContain('model_provider="openai"');
  });

  it("falls back to the CLI when the direct start cannot run", async () => {
    writeFileSync(script, "console.log(process.argv.slice(2).join(\" \"));\n");
    const child = spawnCli(cli, ["app-server"], {
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
      direct: (_, env) => ({ command: join(dir, "missing.exe"), args: ["app-server"], env }),
    });
    expect(await output(child)).toBe("app-server");
  });
});

describe("describeSpawnFailure cwd", () => {
  const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });

  it("names a missing project folder and offers no install", () => {
    const missing = join(tmpdir(), "omb-no-such-folder");
    expect(describeSpawnFailure(enoent, "claude", missing)).toEqual({
      message: `Project folder not found: \`${missing}\`.`,
      setup: false,
      folder: missing,
    });
  });

  it("keeps the install message when the folder exists or no cwd is given", () => {
    const install = { message: "`claude` isn't installed, or isn't on this app's PATH", setup: true };
    expect(describeSpawnFailure(enoent, "claude", tmpdir())).toEqual(install);
    expect(describeSpawnFailure(enoent, "claude")).toEqual(install);
  });
});

describe.runIf(process.platform === "win32")("setCliPriority", () => {
  // The host prints its pid, then on "go" starts an engine child that prints its own and stays.
  const host = `console.log(process.pid); process.stdin.once("data", () => { const c = require("node:child_process").spawn(process.execPath, ["-e", "console.log(process.pid); setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "ignore"] }); });`;
  const pids = (child: ReturnType<typeof spawn>, count: number) => new Promise<number[]>((resolve) => {
    let text = "";
    child.stdout!.on("data", (chunk) => {
      text += chunk;
      const found = text.split(/\s+/).filter(Boolean).map(Number);
      if (found.length >= count) resolve(found);
    });
  });
  const kill = (child: ReturnType<typeof spawn>) => spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });

  it("an adopted engine host and the children it starts run at Normal", async () => {
    const child = spawn(process.execPath, ["-e", host], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    try {
      const [own] = await pids(child, 1);
      setCliPriority(child, "low");
      expect(getPriority(own)).toBe(constants.priority.PRIORITY_BELOW_NORMAL);
      setCliPriority(child, "normal");
      child.stdin!.write("go\n");
      const [engine] = await pids(child, 1);
      for (const pid of [own, engine]) expect(getPriority(pid)).toBe(constants.priority.PRIORITY_NORMAL);
    } finally { kill(child); }
  });

  it("leaves a launcher and the engine it starts at Normal", async () => {
    // The launcher inherits the runner's class, which can itself be below Normal.
    const runner = getPriority();
    setPriority(constants.priority.PRIORITY_NORMAL);
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `""${process.execPath}" -e "console.log(process.pid); setTimeout(() => {}, 30000)""`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: true });
    try {
      setCliPriority(child, "low");
      const [engine] = await pids(child, 1);
      setCliPriority(child, "normal");
      for (const pid of [child.pid!, engine]) expect(getPriority(pid)).toBe(constants.priority.PRIORITY_NORMAL);
    } finally { kill(child); setPriority(runner); }
  });
});
