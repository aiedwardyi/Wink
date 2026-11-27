// Prove the built server actually STARTS with no node_modules in reach.
//
// 0.1.24 shipped a server that died on every launch with
//   ERR_MODULE_NOT_FOUND: Cannot find package 'zod'
// because `tsc` leaves bare imports verbatim and the packaged app carries no
// node_modules. Every existing gate passed it: the unit suite runs in the repo
// (where zod resolves), and the packaging check only asserts index.js EXISTS.
//
// So this copies dist-server OUT of the repo before running it. Inside the
// repo a bare import still resolves by walking up to ./node_modules and the
// test passes on a build that would be dead in the field — which is precisely
// how the bug escaped. The copy is the whole point; do not "simplify" it away.
import { execFile, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { waitForAppToken } from "../electron/local-api-auth.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "omb-smoke-"));
const home = mkdtempSync(join(tmpdir(), "omb-smoke-home-"));
const port = 21000 + Math.floor(Math.random() * 9000);

// OMB_SMOKE_DIST lets the release workflow aim this at a packaged app's
// Resources/server tree instead of the repo build.
const dist = process.env.OMB_SMOKE_DIST ?? join(root, "dist-server");
cpSync(dist, join(staging, "server"), { recursive: true });
// docs/ sits beside the server dir in both the repo and Resources.
cpSync(join(dist, "..", "docs", "harness-playbook.md"), join(staging, "docs", "harness-playbook.md"));
cpSync(join(dist, "..", "docs", "wink-guide.md"), join(staging, "docs", "wink-guide.md"));

const child = spawn(process.execPath, [join(staging, "server", "packaged-boot.js")], {
  cwd: staging,
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  windowsHide: true,
});

const token = await waitForAppToken(child, 20_000);

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

// Best-effort by design. Windows holds file handles open a little longer than
// the process that owned them, so removing the scratch dir immediately after
// the kill raises EPERM; Linux runners can raise EACCES the same way. Scratch
// cleanup must never decide whether the build is good — it failed a green run
// on Windows once already, and see f66d30f for the same lesson on Linux.
const cleanup = () => {
  child.kill("SIGKILL");
  for (const dir of [staging, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will reap it; the assertion below is what matters */
    }
  }
};

const deadline = Date.now() + 45_000;
let listening = false;
let harnessReady = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (health.ok) {
      listening = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
while (listening && Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    const bots = await fetch(`http://127.0.0.1:${port}/api/bots`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      signal: AbortSignal.timeout(Math.max(250, deadline - Date.now())),
    });
    if (bots.ok) {
      harnessReady = true;
      break;
    }
  } catch {
    /* harness still attaching */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// Serving /api/health is necessary but nowhere near sufficient. Bundling
// relocates import.meta.url, so a module that used to sit in drivers/ resolves
// its sibling paths from the bundle's directory instead — one level too high.
// The 0.1.24 candidate booted and answered /api/health perfectly while every
// spawned proxy pointed outside Resources/server, silently killing permission
// prompts, computer use and dweb. So check the paths the server ACTUALLY
// resolved, from inside the staged copy, before calling the build good.
const probe = join(staging, "server", "probe-proxy-paths.mjs");
writeFileSync(
  probe,
  [
    'import { existsSync } from "node:fs";',
    'import { PACKAGED_FILES, SPAWNED_PROXIES } from "./proxy-paths.js";',
    "const resolved = { ...SPAWNED_PROXIES, ...PACKAGED_FILES };",
    "const missing = Object.entries(resolved).filter(([, p]) => !existsSync(p));",
    "console.log(JSON.stringify({ resolved, missing }));",
  ].join("\n"),
);

let proxyReport = null;
try {
  const { stdout } = await promisify(execFile)(process.execPath, [probe], { cwd: staging });
  proxyReport = JSON.parse(stdout);
} catch (error) {
  proxyReport = { error: String((error && error.message) || error) };
}

// boot-reads.ts spawns this worker after the first paint; a bundle without it
// boots and serves, then quietly never recovers mail, asks or sync notices.
const bootProbe = join(staging, "server", "probe-boot-reads.mjs");
writeFileSync(
  bootProbe,
  [
    'import { Worker } from "node:worker_threads";',
    'const worker = new Worker(new URL("./boot-reads-worker.js", import.meta.url), {',
    `  workerData: { dataDir: ${JSON.stringify(home)}, now: Date.now(), askThreads: [], reportThreads: [], cutoverAt: null, notices: { migration: "", conflict: [] } },`,
    "});",
    'worker.once("message", (reply) => { console.log(JSON.stringify(reply)); process.exit(0); });',
    'worker.once("error", (error) => { console.log(JSON.stringify({ error: String(error) })); process.exit(0); });',
  ].join("\n"),
);
let bootReport = null;
try {
  const { stdout } = await promisify(execFile)(process.execPath, [bootProbe], { cwd: staging });
  bootReport = JSON.parse(stdout);
} catch (error) {
  bootReport = { error: String((error && error.message) || error) };
}

// cold-thread.ts reads the first page of every chat the store has not loaded through this worker;
// a bundle without it serves each of those pages by loading the whole chat on the main thread.
const tailProbe = join(staging, "server", "probe-cold-thread.mjs");
writeFileSync(
  tailProbe,
  [
    'import { Worker } from "node:worker_threads";',
    'const worker = new Worker(new URL("./cold-thread-worker.js", import.meta.url));',
    'worker.once("message", (reply) => { console.log(JSON.stringify(reply)); process.exit(0); });',
    'worker.once("error", (error) => { console.log(JSON.stringify({ error: String(error) })); process.exit(0); });',
    `worker.postMessage({ id: 1, file: ${JSON.stringify(join(home, "no-messages.db"))}, threadId: "t", count: 1 });`,
  ].join("\n"),
);
let tailReport = null;
try {
  const { stdout } = await promisify(execFile)(process.execPath, [tailProbe], { cwd: staging });
  tailReport = JSON.parse(stdout);
} catch (error) {
  tailReport = { error: String((error && error.message) || error) };
}

// The public MCP process is a second packaged entry point. Send a request and
// close stdin immediately: this proves both that the bundle has no external
// dependencies and that shutdown lets the final JSON-RPC frame drain.
let mcpReport = null;
if (listening) {
  const mcp = spawn(process.execPath, [join(staging, "server", "mcp-server.js")], {
    cwd: staging,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  mcp.stdout.on("data", (chunk) => (stdout += chunk));
  mcp.stderr.on("data", (chunk) => (stderr += chunk));
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } },
  });
  const health = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_system_health", arguments: {} },
  });
  mcp.stdin.write(`${initialize}\n${health}\n`);
  const healthDeadline = Date.now() + 8_000;
  while (Date.now() < healthDeadline && !stdout.split("\n").some((line) => line.includes('"id":2'))) {
    if (mcp.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The ping is deliberately followed by EOF without waiting. If the stdio
  // close path exits before buffered frames drain, id 3 will be missing.
  mcp.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
  const closed = new Promise((resolve) => mcp.once("close", (code, signal) => resolve({ code, signal })));
  let timeout;
  const exit = await Promise.race([
    closed,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timeout: true }), 10_000);
    }),
  ]);
  clearTimeout(timeout);
  if (exit.timeout) {
    mcp.kill("SIGKILL");
    await closed;
  }
  try {
    const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    mcpReport = { exit, responses, stderr };
  } catch (error) {
    mcpReport = { exit, stdout, stderr, error: String(error) };
  }
}

cleanup();

if (!listening || !harnessReady) {
  console.error(
    !listening
      ? `the packaged boot entry never served /api/health on port ${port}.`
      : `the packaged boot answered /api/health but the fat harness never served /api/bots on port ${port}.`,
  );
  console.error(`exit code: ${child.exitCode}`);
  console.error(output.trim() || "(no output)");
  process.exit(1);
}

if (!proxyReport || proxyReport.error || proxyReport.missing.length > 0) {
  console.error("spawned proxy paths do not resolve inside the packaged server dir:");
  console.error(JSON.stringify(proxyReport, null, 2));
  console.error("\nthe server would still answer /api/health — and every one of these");
  console.error("features would be dead: permission prompts, computer use, dweb, peer comms.");
  process.exit(1);
}

if (!bootReport || bootReport.error || !Array.isArray(bootReport.rows?.receipts)) {
  console.error("the packaged boot-reads-worker.js did not load and reply inside the packaged server dir:");
  console.error(JSON.stringify(bootReport, null, 2));
  process.exit(1);
}

if (!tailReport || tailReport.error || tailReport.id !== 1 || !Array.isArray(tailReport.value?.messages)) {
  console.error("the packaged cold-thread-worker.js did not load and reply inside the packaged server dir:");
  console.error(JSON.stringify(tailReport, null, 2));
  process.exit(1);
}

if (
  !mcpReport ||
  mcpReport.error ||
  mcpReport.exit?.timeout ||
  mcpReport.exit?.code !== 0 ||
  mcpReport.responses?.find((response) => response.id === 1)?.result?.serverInfo?.name !== "openmausbot-mcp" ||
  mcpReport.responses?.find((response) => response.id === 2)?.result?.structuredContent?.status !== "connected" ||
  JSON.stringify(mcpReport.responses?.find((response) => response.id === 3)?.result) !== "{}"
) {
  console.error("the packaged MCP stdio server failed its initialize-health-and-drain smoke test:");
  console.error(JSON.stringify(mcpReport, null, 2));
  process.exit(1);
}

const count = Object.keys(proxyReport.resolved).length;
console.log(`packaged boot answered health then /api/bots with no node_modules in reach (port ${port}) ✓`);
console.log(`all ${count} spawned proxy paths resolve inside the packaged server dir ✓`);
console.log("packaged boot-reads-worker.js loaded and returned its rows ✓");
console.log("packaged cold-thread-worker.js loaded and answered a page read ✓");
console.log("packaged MCP stdio server reached the API and flushed its final frames ✓");
