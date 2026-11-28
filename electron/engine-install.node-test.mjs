import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as terminal from "./terminal-launch.mjs";

for (const shell of ["powershell.exe", "pwsh.exe"]) {
  for (const scenario of ["success", "failure", "npm present", "npm missing", "winget failure", "winget missing", "irm Claude install", "irm failure", "installer exit"]) {
    test(`${shell}: ${scenario}`, { skip: process.platform !== "win32" }, () => {
      const dir = mkdtempSync(join(tmpdir(), "wink-engine-install-"));
      const bin = join(dir, "fresh-bin");
      const claude = scenario === "irm Claude install";
      const home = join(dir, "fresh home");
      const nativeBin = join(home, ".local", "bin");
      mkdirSync(bin);
      const log = join(dir, "calls.txt");
      const quote = (value) => `'${value.replaceAll("'", "''")}'`;
      const cmd = (name, body) => writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n${body}\r\n`);
      try {
        if (claude) {
          mkdirSync(nativeBin, { recursive: true });
          cmd("staged-claude", `echo signin %*>>"${log}"\r\nexit /b 0`);
        }
        const stageClaude = claude ? `\r\ncopy /y "${join(dir, "staged-claude.cmd")}" "${join(nativeBin, "claude.cmd")}" >nul` : "";
        cmd("install", `echo install>>"${log}"${stageClaude}\r\nexit /b ${scenario === "failure" ? 7 : 0}`);
        cmd("fresh-bin/signin", `echo signin>>"${log}"\r\nexit /b 0`);
        cmd("staged-npm", `echo npm>>"${log}"\r\nexit /b 0`);
        if (scenario === "npm present") cmd("npm", `echo npm>>"${log}"\r\nexit /b 0`);
        if (scenario !== "winget missing") cmd("winget", `echo winget>>"${log}"\r\ncopy /y "${join(dir, "staged-npm.cmd")}" "${join(dir, "npm.cmd")}" >nul\r\nexit /b ${scenario === "winget failure" ? 8 : 0}`);
        const npm = scenario.startsWith("winget") || scenario.startsWith("npm");
        const command = scenario === "installer exit" ? "Write-Output 'installer-output'; Invoke-Expression 'exit 7'"
          : scenario.startsWith("irm") ? `function Invoke-RestMethod { '${scenario === "irm failure" ? "Write-Error stub-failure" : "install"}' }\nirm https://stub.invalid/install.ps1 | iex`
            : npm ? "npm install -g stub" : "install";
        const failMarker = join(dir, "it's failed.marker");
        const script = terminal.buildInstallScript({ command, needsNode: true, signInCommand: claude ? "claude auth login" : "signin", driverKind: claude ? "claudeAgent" : "codex", failMarker }, "win32");
        // Keep PATH refresh on the stub tools.
        const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0");
        const harness = `class Environment { static [string] GetEnvironmentVariable([string] $name, [string] $target) { return $env:WINK_TEST_PATH } }\n$env:Path=${quote(`${dir};${powershell}`)}\n& {\n${script}\n}\nWrite-Output 'parent-alive'`;
        const result = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(harness, "utf16le").toString("base64")], {
          encoding: "utf8", windowsHide: true, timeout: 30000,
          env: { ...process.env, ...(claude ? { USERPROFILE: home, HOME: home } : {}), WINK_TEST_PATH: `${dir};${bin};${powershell}` },
        });
        assert.ifError(result.error);
        const calls = (() => { try { return readFileSync(log, "utf8").trim().split(/\r?\n/); } catch { return []; } })();
        const expected = claude ? ["install", "signin auth login"]
          : scenario === "success" ? ["install", "signin"]
            : scenario === "failure" ? ["install"]
              : scenario === "npm present" ? ["npm", "signin"]
                : scenario === "npm missing" ? ["winget", "npm", "signin"]
                  : scenario === "winget failure" ? ["winget"] : [];
        assert.deepEqual(calls, expected, `${result.stdout}\n${result.stderr}`);
        if (["success", "installer exit"].includes(scenario)) assert.match(result.stdout, /parent-alive/);
        if (scenario === "installer exit") assert.match(result.stdout, /installer-output/);
        if (["winget failure", "winget missing"].includes(scenario)) assert.match(result.stdout, /Node\.js didn't install\..*https:\/\/nodejs\.org/);
        if (["failure", "installer exit"].includes(scenario)) assert.match(result.stdout, /The install didn't finish\./);
        assert.equal(existsSync(failMarker), ["failure", "winget failure", "winget missing", "irm failure", "installer exit"].includes(scenario), "failure marker");
        if (scenario === "irm failure") assert.ok(result.stderr, "PowerShell error stays visible");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
