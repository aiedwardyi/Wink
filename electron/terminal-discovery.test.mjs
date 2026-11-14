import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createTerminalBridge } from "./terminal-bridge.mjs";
import { installOrbitMsg } from "./terminal-mailbox.mjs";
import { loadTerminalBridgeToken, publishTerminalDiscovery } from "./terminal-discovery.mjs";

it("loads one complete identity under concurrent starts", async () => {
  const profile = await fs.mkdtemp(path.join(os.homedir(), "bridge-identity-"));
  const tokens = await Promise.all(Array.from({ length: 8 }, () => loadTerminalBridgeToken(profile)));
  expect(new Set(tokens).size).toBe(1);
  expect(await fs.readFile(path.join(profile, "terminal-bridge-token"), "utf8")).toBe(tokens[0]);
  expect(await fs.readdir(profile)).toEqual(["terminal-bridge-token"]);
});

it.skipIf(process.platform !== "win32")("persists bridge identity and the old-env session hook discovers the restarted port", async () => {
  const root = await fs.mkdtemp(path.join(os.homedir(), "bridge-discovery-"));
  const profile = path.join(root, "프로필");
  const bin = await installOrbitMsg(path.join(root, ".orbit", "bin"), "win32", profile);
  const posts = [];
  const host = { readBot() {}, sendBot() {}, captureWorkerSession(auth, input) { posts.push({ auth, input }); return auth === "Bearer old-pane-auth"; } };
  const first = createTerminalBridge({ host, profile });
  const old = await first.start();
  await first.close();
  const second = createTerminalBridge({ host });
  try {
    const current = await second.start(profile);
    expect(current.token).toBe(old.token);
    await publishTerminalDiscovery(profile, current, "http://127.0.0.1:8799");
    const discovery = JSON.parse(await fs.readFile(path.join(profile, "terminal-discovery.json"), "utf8"));
    expect(discovery.url).toBe(current.url);
    expect(discovery).not.toHaveProperty("token");
    if (process.platform !== "win32") expect((await fs.stat(path.join(profile, "terminal-discovery.json"))).mode & 0o777).toBe(0o600);
    const hook = { hook_event_name: "SessionStart", source: "resume", session_id: "native-id", transcript_path: null, cwd: root };
    const result = await new Promise(resolve => {
      const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(bin, "orbit-session.ps1")], {
        windowsHide: true, env: { ...process.env, HOME: root, USERPROFILE: root, ORBIT_PANE: "old-pane", ORBIT_SESSION_URL: `${old.url}/v1/terminal/session`, ORBIT_SESSION_AUTH: "old-pane-auth", ORBIT_SESSION_GENERATION: "old-generation" },
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
      child.stdin.end(JSON.stringify(hook));
    });
    expect(result.code, result.stderr).toBe(0);
    expect(posts).toEqual([{ auth: "Bearer old-pane-auth", input: { pane: "old-pane", launchGeneration: "old-generation", session_id: "native-id", transcript_path: null, cwd: root, source: "resume" } }]);
  } finally { await second.close(); }
});
