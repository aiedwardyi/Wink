import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_DRIVERS } from "../server/drivers/builtIn.ts";
import { createFixtureHome } from "../server/testing/test-home.ts";
import { trustedTerminalSender } from "./terminal-host.mjs";
import * as terminal from "./terminal-launch.mjs";

const install = await import("./engine-install.mjs").catch(() => ({}));
const descriptor = { driverKind: "codex", command: "npm install -g official", needsNode: true, signInCommand: "official login" };
const encodedCommand = Buffer.from(`$ErrorActionPreference='Stop'\n${descriptor.command}`, "utf16le").toString("base64");
const encodedSignIn = (script) => Buffer.from(script, "utf16le").toString("base64");

function setup(trusted = true, opened = true) {
  const handlers = {};
  const dir = mkdtempSync(join(tmpdir(), "wink-install-marker-"));
  const marker = (id) => join(dir, `${id}.failed`);
  const contents = { isDestroyed: () => false, getURL: () => "http://localhost:5199/", mainFrame: { url: "http://localhost:5199/" } };
  const event = { sender: trusted ? contents : {}, senderFrame: contents.mainFrame };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => descriptor }));
  const copy = vi.fn();
  const open = vi.fn(async () => opened);
  const blank = vi.fn(async () => true);
  const server = vi.fn(() => ({ port: 8799, token: "test-token" }));
  install.registerEngineInstall({ handle: (channel, fn) => { handlers[channel] = fn; } }, {
    trusted: (caller) => trustedTerminalSender(caller, contents, "http://localhost:5199"),
    server, fetch, copy, open, blank, marker,
  });
  expect(Object.keys(handlers)).toEqual(["engine:install", "engine:install-failed"]);
  return { call: (id, ...rest) => handlers["engine:install"](event, id, ...rest), failed: (id) => handlers["engine:install-failed"](event, id), marker, server, fetch, copy, open, blank };
}

describe("engine install IPC", () => {
  it("reports a failure marker the install window wrote and clears it before the next launch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const d = setup();
      writeFileSync(d.marker("codex"), "failed");
      expect(await d.call("codex")).toBe("running");
      expect(d.open).toHaveBeenLastCalledWith({ ...descriptor, failMarker: d.marker("codex") });
      expect(existsSync(d.marker("codex"))).toBe(false);
      expect(await d.failed("codex")).toBe(false);
      writeFileSync(d.marker("codex"), "failed");
      expect(await d.failed("codex")).toBe(true);
      expect(await d.failed("claude")).toBe(false);
      vi.setSystemTime(Date.now() + 10000);
      expect(await d.call("codex")).toBe("running");
      expect(await d.failed("codex")).toBe(false);
      writeFileSync(d.marker("codex"), "failed");
      expect(await d.failed("codex")).toBe(true);
      expect(await d.call("codex")).toBe("running");
      expect(d.open).toHaveBeenCalledTimes(3);
      expect(await d.failed("codex")).toBe(false);
      vi.setSystemTime(Date.now() + 10000);
      let resolveFetch;
      d.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
      writeFileSync(d.marker("codex"), "failed");
      const retry = d.call("codex");
      expect(await d.failed("codex")).toBe(false);
      resolveFetch({ ok: true, json: async () => descriptor });
      expect(await retry).toBe("running");
      await expect(d.failed("../codex")).rejects.toThrow("Invalid engine id");
      const untrusted = setup(false);
      await expect(untrusted.failed("codex")).rejects.toThrow("Untrusted install caller");
    } finally { vi.useRealTimers(); }
  });

  it("guards an instance during resolution, launch, and the 10-second repeat window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const d = setup();
    let resolveFetch;
    let resolveOpen;
    d.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
    d.open.mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve; }));
    try {
      const first = d.call("codex");
      const settled = vi.fn();
      const repeat = d.call("codex", true).then(settled);
      await vi.waitFor(() => expect(d.fetch).toHaveBeenCalledTimes(1));
      expect(settled).not.toHaveBeenCalled();
      resolveFetch({ ok: true, json: async () => descriptor });
      await vi.waitFor(() => expect(d.open).toHaveBeenCalledTimes(1));
      vi.setSystemTime(Date.now() + 20000);
      const duringLaunch = d.call("codex");
      expect(settled).not.toHaveBeenCalled();
      expect(d.open).toHaveBeenCalledTimes(1);
      resolveOpen(true);
      expect(await first).toBe("running");
      await repeat;
      expect(settled).toHaveBeenCalledExactlyOnceWith("running");
      expect(await duringLaunch).toBe("running");
      vi.setSystemTime(Date.now() + 9999);
      expect(await d.call("codex")).toBe("running");
      expect(d.open).toHaveBeenCalledTimes(1);
      expect(await d.call("claude")).toBe("running");
      expect(d.open).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + 1);
      expect(await d.call("codex")).toBe("running");
      expect(d.open).toHaveBeenCalledTimes(3);
      expect(d.copy).not.toHaveBeenCalled();
      expect(d.blank).not.toHaveBeenCalled();
    } finally {
      resolveFetch?.({ ok: true, json: async () => descriptor });
      resolveOpen?.(true);
      vi.useRealTimers();
    }
  });

  it.each(["opened", "copied", "rejection"])("shares pending %s with overlapping callers", async (result) => {
    const d = setup(true, false);
    const failure = new Error("offline");
    let resolveFetch;
    let rejectFetch;
    d.fetch.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveFetch = resolve; rejectFetch = reject; }));
    d.blank.mockResolvedValue(result === "opened");
    const results = Promise.allSettled([d.call("codex"), d.call("codex", true)]);
    await vi.waitFor(() => expect(d.fetch).toHaveBeenCalledTimes(1));
    if (result === "rejection") rejectFetch(failure);
    else resolveFetch({ ok: true, json: async () => descriptor });
    const expected = result === "rejection" ? { status: "rejected", reason: failure } : { status: "fulfilled", value: result };
    expect(await results).toEqual([expected, expected]);
    expect(d.fetch).toHaveBeenCalledOnce();
    expect(d.open).toHaveBeenCalledTimes(result === "rejection" ? 0 : 1);
  });

  it("shares a synchronous server failure and allows the next tap to retry", async () => {
    const d = setup();
    const failure = new Error("server unavailable");
    d.server.mockImplementationOnce(() => { throw failure; });
    const results = await Promise.allSettled([d.call("codex"), d.call("codex")]);
    expect(results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(await d.call("codex")).toBe("running");
    expect(d.server).toHaveBeenCalledTimes(2);
    expect(d.open).toHaveBeenCalledOnce();
  });

  it("allows retry after a failed resolution or clipboard fallback", async () => {
    const d = setup();
    d.fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(d.call("codex")).rejects.toThrow("offline");
    d.open.mockResolvedValueOnce(false);
    expect(await d.call("codex")).toBe("opened");
    expect(await d.call("codex")).toBe("running");
    expect(d.open).toHaveBeenCalledTimes(2);
  });

  it("resolves only the id and ignores renderer command arguments", async () => {
    const d = setup();
    expect(await d.call("codex", "renderer payload")).toBe("running");
    expect(d.fetch).toHaveBeenCalledWith("http://127.0.0.1:8799/api/instances/codex/install", expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer test-token" } }));
    expect(d.open).toHaveBeenCalledExactlyOnceWith({ ...descriptor, failMarker: d.marker("codex") });
    expect(JSON.stringify(d.open.mock.calls)).not.toContain("renderer payload");
    expect(d.copy).not.toHaveBeenCalled();
  });

  it.each([[true, false], [undefined, true]])("install-only %s keeps sign-in %s", async (installOnly, signIn) => {
    const d = setup();
    expect(await d.call("codex", installOnly)).toBe("running");
    const script = terminal.buildInstallScript(d.open.mock.calls[0][0], "win32");
    expect(script.includes(encodedSignIn(descriptor.signInCommand))).toBe(signIn);
    expect(script).toContain(encodedCommand);
  });

  it("refuses an untrusted sender before resolving commands", async () => {
    const d = setup(false);
    await expect(d.call("codex")).rejects.toThrow("Untrusted");
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });

  it.each(["codex;whoami", "codex login", "", null, { instanceId: "codex", command: "whoami" }])("refuses bad instance id %j", async (id) => {
    const d = setup();
    await expect(d.call(id)).rejects.toThrow("Invalid engine id");
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });

  it.each([true, false])("copies the server command on launch failure (blank %s)", async (opened) => {
    const d = setup(true, false);
    d.blank.mockResolvedValue(opened);
    expect(await d.call("codex")).toBe(opened ? "opened" : "copied");
    expect(d.copy).toHaveBeenCalledExactlyOnceWith(descriptor.command);
    expect(d.blank).toHaveBeenCalledOnce();
  });

  it("logs and falls back when launching throws", async () => {
    const d = setup();
    const failure = new Error("launcher failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    d.open.mockRejectedValue(failure);
    try {
      expect(await d.call("codex")).toBe("opened");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("[engine-install]"), failure);
      expect(d.copy).toHaveBeenCalledExactlyOnceWith(descriptor.command);
    } finally {
      log.mockRestore();
    }
  });

  it("does not launch a missing server descriptor", async () => {
    const d = setup();
    d.fetch.mockResolvedValue({ ok: false });
    await expect(d.call("missing")).rejects.toThrow();
    expect(d.open).not.toHaveBeenCalled();
    expect(d.blank).not.toHaveBeenCalled();
  });

  it("wires the command-free preload and main handler", () => {
    expect(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8")).toContain('openEngineInstall: (instanceId, installOnly) => invoke("engine:install", instanceId, installOnly)');
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    expect(main).toContain("registerEngineInstall(ipcMain,");
    expect(main).toContain("trusted: (event) => trustedTerminalSender(event, mainWindow?.webContents, rendererOrigin())");
  });
});

describe("install terminal script", () => {
  it("checks npm and bootstraps Node before installing", () => {
    const script = terminal.buildInstallScript(descriptor, "win32");
    expect(script).toContain("Get-Command npm -ErrorAction SilentlyContinue");
    expect(script).toContain("winget install -e --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements");
    expect(script.indexOf("winget install")).toBeLessThan(script.indexOf(encodedCommand));
  });

  it("pins the Node install to the winget source and says what to do when a step fails", () => {
    const lines = terminal.buildInstallScript(descriptor, "win32").split("\n");
    const winget = lines.findIndex((line) => line.includes("winget install"));
    expect(lines[winget]).toContain("try { winget install -e --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements;");
    expect(lines[winget + 1]).toMatch(/^if \(-not \$node\) \{ Write-Host ".*https:\/\/nodejs\.org.*"; return \}$/);
    const failures = lines.filter((line) => line.includes("return"));
    expect(failures).toHaveLength(2);
    for (const line of failures) expect(line).toMatch(/Write-Host "[^"]+"; return \}$/);
  });

  it("keeps a Claude install free of the Node step", () => {
    const signIn = "claude auth login";
    const lines = terminal.buildInstallScript({ driverKind: "claudeAgent", command: "irm https://claude.ai/install.ps1 | iex", needsNode: false, signInCommand: signIn }, "win32").split("\n");
    expect(lines.join("\n")).not.toMatch(/winget|nodejs/i);
    expect(lines[0]).toBe("$ErrorActionPreference='Stop'");
    expect(lines[1]).toBe(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedSignIn("$ErrorActionPreference='Stop'\nirm https://claude.ai/install.ps1 | iex")}`);
    expect(lines[2]).toMatch(/^if \(\$LASTEXITCODE -ne 0\) \{ Write-Host "[^"]+"; return \}$/);
    expect(lines.at(-1)).toBe(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedSignIn(`$env:Path=(Join-Path $HOME '.local/bin')+';'+$env:Path; ${signIn}`)}`);
  });

  it("writes the failure marker on each failed step, quoting its path", () => {
    const failMarker = "C:\\Users\\O'Neil\\AppData\\Local\\Temp\\wink-install-codex.failed";
    const lines = terminal.buildInstallScript({ ...descriptor, failMarker }, "win32").split("\n");
    const failures = lines.filter((line) => line.includes("return"));
    expect(failures).toHaveLength(2);
    for (const line of failures) {
      expect(line).toContain("try { Set-Content -LiteralPath 'C:\\Users\\O''Neil\\AppData\\Local\\Temp\\wink-install-codex.failed' -Value failed } catch {}; return }");
      expect(line.indexOf("Write-Host")).toBeLessThan(line.indexOf("Set-Content"));
    }
    expect(terminal.buildInstallScript({ ...descriptor, failMarker }, "darwin")).toBe(terminal.buildInstallScript(descriptor, "darwin"));
  });

  it("refreshes registry PATH before the npm check", () => {
    const script = terminal.buildInstallScript(descriptor, "win32");
    expect(script.indexOf("[Environment]::GetEnvironmentVariable('Path', 'Machine')")).toBeLessThan(script.indexOf("Get-Command npm"));
  });

  it("never bootstraps Node for an irm installer", () => {
    const script = terminal.buildInstallScript({ ...descriptor, command: "irm https://npm.example.com/install.ps1 | iex" }, "win32");
    expect(script).not.toContain("winget");
    expect(script).toContain("$ErrorActionPreference='Stop'");
  });

  it("refreshes registry PATH after the install and before sign-in", () => {
    const script = terminal.buildInstallScript(descriptor, "win32");
    const refresh = script.lastIndexOf("[Environment]::GetEnvironmentVariable('Path', 'Machine')");
    expect(refresh).toBeGreaterThan(script.indexOf(encodedCommand));
    expect(refresh).toBeLessThan(script.indexOf(encodedSignIn(descriptor.signInCommand)));
    expect(script).toContain("[Environment]::GetEnvironmentVariable('Path', 'User')");
  });

  it.each(["win32", "darwin"])("skips placeholder sign-in on %s", (platform) => {
    const script = terminal.buildInstallScript({ ...descriptor, signInCommand: "official login YOUR_API_KEY" }, platform);
    expect(script).toContain(platform === "win32" ? encodedCommand : descriptor.command);
    expect(script).not.toContain("YOUR_API_KEY");
    if (platform === "win32") expect(script.split("-EncodedCommand")).toHaveLength(2);
  });

  it.each(["win32", "darwin"])("prefixes agy sign-in on %s", (platform) => {
    const script = terminal.buildInstallScript({ ...descriptor, driverKind: "antigravityAgent", signInCommand: "agy" }, platform);
    expect(script).toContain(platform === "win32" ? encodedSignIn("$env:AGY_CLI_DISABLE_AUTO_UPDATE='true'; agy") : "AGY_CLI_DISABLE_AUTO_UPDATE=true agy");
  });

  it("keeps a multi-statement sign-in as one encoded command", () => {
    const signInCommand = "official login\nwhoami; Remove-Item x";
    const plain = terminal.buildInstallScript({ ...descriptor, signInCommand: "official login" }, "win32").split("\n");
    const lines = terminal.buildInstallScript({ ...descriptor, signInCommand }, "win32").split("\n");
    expect(lines).toHaveLength(plain.length);
    expect(lines.at(-1)).toBe(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedSignIn(signInCommand)}`);
    expect(lines.join("\n")).not.toMatch(/whoami|Remove-Item/);
  });

  it.each(["win32", "darwin", "linux"])("launches one script or falls back on %s", async (platform) => {
    const run = vi.fn(() => {
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    expect(await terminal.openInstallTerminal(descriptor, platform, run)).toBe(platform !== "linux");
    if (platform === "linux") expect(run).not.toHaveBeenCalled();
    else {
      expect(run).toHaveBeenCalledOnce();
      const [file, args] = run.mock.calls[0];
      expect(file).toBe(platform === "win32" ? "cmd.exe" : "osascript");
      if (platform === "win32") {
        expect(args.slice(0, -1)).toEqual(["/c", "start", "", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-EncodedCommand"]);
        expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).toBe(terminal.buildInstallScript(descriptor, platform));
      } else expect(args.join(" ")).toContain("do script");
    }
  });
});

// Each official installer's real target dir; they edit rc files but never the shell that ran them.
const INSTALLERS = {
  "https://claude.ai/install.sh": ["claude", ".local/bin"],
  "https://chatgpt.com/codex/install.sh": ["codex", ".local/bin"],
  "https://antigravity.google/cli/install.sh": ["agy", ".local/bin"],
  "https://x.ai/cli/install.sh": ["grok", ".grok/bin"],
  "https://dev.meta.ai/install.sh": ["muse", ".local/bin"],
};
const posixShells = process.platform === "win32"
  ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe")]
  : ["/bin/bash", "/bin/zsh"];
const posixInstalls = BUILT_IN_DRIVERS.filter((driver) => driver.install?.command?.darwin)
  .map((driver) => [driver.driverKind, { ...driver.install, command: driver.install.command.darwin, driverKind: driver.driverKind }]);

describe.each(posixShells.filter((shell) => existsSync(shell)))("fresh Mac install in %s", (shell) => {
  it.each(posixInstalls)("%s installs and signs in with no Node on PATH", (_kind, install) => {
    const home = createFixtureHome("engine-install-home");
    const bin = createFixtureHome("engine-install-bin");
    const log = join(bin, "calls.txt");
    for (const [url, [name, dir]] of Object.entries(INSTALLERS)) {
      writeFileSync(join(bin, `${name}.installer`), `mkdir -p "$HOME/${dir}"\nprintf '#!/bin/sh\\necho "${name} $*" >> "$LOG"\\n' > "$HOME/${dir}/${name}"\nchmod +x "$HOME/${dir}/${name}"\n`);
      writeFileSync(join(bin, `${name}.url`), url);
    }
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nfor url; do :; done\necho "curl $url" >> "$LOG"\nfor known in "$STUBS"/*.url; do\n  [ "$(cat "$known")" = "$url" ] && exec cat "\${known%.url}.installer"\ndone\nexit 22\n`);
    chmodSync(join(bin, "curl"), 0o755);
    // Only the tools the installers use: a host with Node in /usr/bin must not leak it onto PATH.
    const tools = createFixtureHome("engine-install-tools");
    for (const tool of ["bash", "sh", "cat", "mkdir", "chmod"]) {
      const found = ["/usr/bin", "/bin"].map((dir) => join(dir, tool)).find((file) => existsSync(file));
      if (found) symlinkSync(found, join(tools, tool));
    }
    const system = process.platform === "win32" ? join(shell, "..") : tools;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home)$/i.test(key)));
    const run = (script) => spawnSync(shell, ["-c", script], {
      encoding: "utf8", timeout: 30000, windowsHide: true,
      env: { ...env, PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${system}`, HOME: home, LOG: log, STUBS: bin },
    });
    expect(run("command -v npm node").stdout).toBe("");
    const result = run(terminal.buildInstallScript(install, "darwin"));
    const [name] = INSTALLERS[install.command.match(/https:\/\/\S+/)?.[0]] ?? [];
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split(/\r?\n/).map((line) => line.trim()) : [];
    expect(calls, `${result.stdout}\n${result.stderr}`).toEqual([`curl ${install.command.match(/https:\/\/\S+/)?.[0]}`, `${name} ${install.signInCommand.split(" ").slice(1).join(" ")}`.trim()]);
  });
});
