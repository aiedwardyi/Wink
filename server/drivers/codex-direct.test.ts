import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTempDirs } from "../testing/cleanup.ts";
import { codexDirect } from "./codex-direct.ts";

const temp = createTempDirs();
afterEach(() => temp.remove());

const TARGET = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";

function fakeCodexInstall(version = "0.166.0") {
  const npm = temp.make(join(tmpdir(), "omb-codex-shim-"));
  const root = join(npm, "node_modules", "@openai", "codex");
  const script = join(root, "bin", "codex.js");
  const platform = join(root, "node_modules", "@openai", `codex-win32-${process.arch}`);
  const exe = join(platform, "vendor", TARGET, "bin", "codex.exe");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(platform, "vendor", TARGET, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@openai/codex", version }));
  writeFileSync(script, "");
  writeFileSync(join(platform, "package.json"), JSON.stringify({ name: "@openai/codex", version: `${version}-win32-${process.arch}` }));
  writeFileSync(exe, "");
  const launch = { command: join(npm, "node.exe"), args: [script, "app-server", "-c", "x=1"] };
  return { npm, root, platform, exe, launch };
}

describe.runIf(process.platform === "win32")("codexDirect (npm shim mirror)", () => {
  it("names the platform exe, keeps the args and hands it the shim's env", () => {
    const { root, exe, launch } = fakeCodexInstall();
    expect(codexDirect(launch, { PATH: "p", CODEX_MANAGED_BY_BUN: "1" })).toEqual({
      command: exe,
      args: ["app-server", "-c", "x=1"],
      env: { PATH: "p", CODEX_MANAGED_PACKAGE_ROOT: realpathSync(root), CODEX_MANAGED_BY_NPM: "1" },
    });
  });

  it("finds a platform package hoisted next to the main one, like require.resolve", () => {
    const { npm, platform, launch } = fakeCodexInstall();
    rmSync(platform, { recursive: true });
    const hoisted = join(npm, "node_modules", "@openai", `codex-win32-${process.arch}`);
    mkdirSync(join(hoisted, "vendor", TARGET, "bin"), { recursive: true });
    writeFileSync(join(hoisted, "package.json"), JSON.stringify({ version: `0.166.0-win32-${process.arch}` }));
    writeFileSync(join(hoisted, "vendor", TARGET, "bin", "codex.exe"), "");
    expect(codexDirect(launch, {})?.command).toBe(join(hoisted, "vendor", TARGET, "bin", "codex.exe"));
  });

  it.each<[string, (install: ReturnType<typeof fakeCodexInstall>) => void, Record<string, string>?]>([
    ["the exe is missing", ({ exe }) => rmSync(exe)],
    ["the platform package is missing", ({ platform }) => rmSync(platform, { recursive: true })],
    ["the platform package is another version", ({ platform }) => writeFileSync(join(platform, "package.json"), JSON.stringify({ version: `0.165.0-win32-${process.arch}` }))],
    ["the package is not codex", ({ root }) => writeFileSync(join(root, "package.json"), JSON.stringify({ name: "other", version: "0.166.0" }))],
    ["pnpm owns the install", ({ npm }) => writeFileSync(join(npm, "node_modules", ".modules.yaml"), "")],
    ["bun owns the install", () => {}, { npm_config_user_agent: "bun/1.2.0 npm/? node/v22" }],
  ])("keeps the shim when %s", (_, edit, env = {}) => {
    const install = fakeCodexInstall();
    edit(install);
    expect(codexDirect(install.launch, env)).toBeNull();
  });

  it("leaves a launch that is not the codex shim alone", () => {
    const { exe, launch } = fakeCodexInstall();
    expect(codexDirect({ command: exe, args: ["app-server"] }, {})).toBeNull();
    expect(codexDirect({ command: process.execPath, args: [join(tmpdir(), "codex.js")] }, {})).toBeNull();
    expect(codexDirect({ command: "wsl.exe", args: launch.args }, {})).toBeNull();
  });
});

describe.runIf(process.platform !== "win32")("codexDirect off Windows", () => {
  it("keeps the shim", () => {
    expect(codexDirect({ command: "node", args: ["/usr/lib/node_modules/@openai/codex/bin/codex.js"] }, {})).toBeNull();
  });
});
