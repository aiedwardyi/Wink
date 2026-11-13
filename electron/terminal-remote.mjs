import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { orbitBinFiles } from "./terminal-mailbox.mjs";
import { quoteWindows } from "./terminal-worker.mjs";

export const REMOTE_PANE_CEILING = 64;
const GB = 1024 ** 3;
const RESERVE = 1.5 * GB;
const PANE_MEMORY = 0.6 * GB;
// A new claude's memory reaches the probe only after it has loaded.
const STARTING_MS = 60_000;
// Probe and push share this, so even with a 15 s shell start an open beats the proxy's 30 s spawn deadline.
const OPEN_MS = 12_000;
const FIRST_PORT = 40_000;
const PORT_COUNT = 9_000;
// UTF-16 base64 grows the bootstrap 2.7x and Windows caps a command line at 32K.
const SCRIPT_LIMIT = 11_000;
const ENV_KEYS = ["ORBIT_PANE", "ORBIT_BOT", "ORBIT_TEACHER", "ORBIT_MSG_AUTH"];
const SSH_LAUNCH = "-o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ExitOnForwardFailure=yes";
const BIN_HASH = "orbit-bin.hash";
const SSH_RE = /^\w[\w.@-]{0,63}$/;
const ROOT_RE = /^[A-Za-z]:(?:[\\/][\w.-]+)+$/;
const CLAUDE_RE = /^\s*&?\s*["']?(?:[^\s"';&|]*[\\/])?claude(?:\.(?:exe|cmd|ps1))?["']?(?=\s|$)/i;
// Quoted text matches first and is kept, so only a top-level flag is dropped.
const WORKER_SETTINGS_RE = /("[^"]*"|'[^']*')|\s--settings\s+(?:"[^"]*claude-worker\.json"|'[^']*claude-worker\.json'|[^\s"']*claude-worker\.json)(?=\s|$)/gi;

const gb = (bytes) => (bytes / GB).toFixed(1);

/** A terminal_spawn host from ~/.orbit/remote-hosts.json; only `enabled: true` entries run panes. */
export function remoteHost(name, hosts) {
  const entry = hosts && Object.hasOwn(hosts, name) ? hosts[name] : null;
  if (entry?.enabled !== true) throw new Error(`Unknown terminal host: ${name}`);
  const ssh = String(entry.ssh ?? name);
  const root = String(entry.root ?? "").replace(/[\\/]+$/, "");
  const account = String(entry.account ?? "").toLowerCase();
  if (!SSH_RE.test(ssh) || !ROOT_RE.test(root) || root.split(/[\\/]/).some((part) => /^\.+$/.test(part)) || !/^[^@\s]+@[^@\s]+$/.test(account)) {
    throw new Error(`Invalid terminal host: ${name}`);
  }
  return { name, ssh, root: root.replace(/\//g, "\\"), account };
}

/** The bot's claude args minus its home worker settings; claude is the only remote engine so far. */
export function remoteArgs(command) {
  const match = CLAUDE_RE.exec(command ?? "");
  if (!match || /[\r\n]/.test(command)) throw new Error("Remote terminals run a one-line claude command");
  return command.slice(match[0].length).replace(WORKER_SETTINGS_RE, (_, quoted) => quoted ?? "");
}

/** Picks a free tunnel port on the host and counts its panes still starting; `panes` are its live and opening ones. */
export function remoteSlot(host, panes, at, random = randomInt) {
  const there = panes.filter((pane) => pane.host === host);
  if (there.length >= REMOTE_PANE_CEILING) throw new Error(`Too many terminals on ${host} (limit ${REMOTE_PANE_CEILING}).`);
  const used = new Set(there.map((pane) => pane.port));
  const free = Array.from({ length: PORT_COUNT }, (_, index) => FIRST_PORT + index).filter((port) => !used.has(port));
  return { host, port: free[random(free.length)], at, starting: there.filter((pane) => at - pane.at < STARTING_MS).length };
}

/** The typed line: a fixed bootstrap that takes the pane's own $env:ORBIT_* at run time, so the grant is never typed. */
export function remoteLaunchLine({ host, port, cwd, args }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue",
    // localhost skips orbit-msg's 127.0.0.1 fallback ports, which belong to the host's own Wink.
    `$env:ORBIT_URL = 'http://localhost:${port}'`,
    "$env:CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'false'",
    `$env:PATH = ${quoteWindows(`${host.root}\\bin;`)} + $env:PATH`,
    `$env:ORBIT_SCRATCH = ${quoteWindows(`${host.root}\\scratch\\`)} + $env:ORBIT_PANE`,
    "New-Item -ItemType Directory -Force $env:ORBIT_SCRATCH | Out-Null",
    "$env:TEMP = $env:ORBIT_SCRATCH; $env:TMP = $env:ORBIT_SCRATCH",
    `Set-Location -LiteralPath ${quoteWindows(cwd)}`,
    `& claude${args} --settings ${quoteWindows(`${host.root.replace(/\\/g, "/")}/bin/claude-worker.json`)} --strict-mcp-config`,
  ].join("\n");
  if (script.length > SCRIPT_LIMIT) throw new Error("Remote launch is too long; keep the prompt under 10 KB");
  const env = `('${ENV_KEYS.map((key, index) => `$env:${key} = ''{${index}}''; `).join("")}' -f ${ENV_KEYS.map((key) => `$env:${key}`).join(", ")})`;
  return `$s = ${env} + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString("base64")}')); `
    + `ssh -t ${SSH_LAUNCH} -R "${port}:$(([uri]$env:ORBIT_URL).Authority)" ${host.ssh} "powershell -NoProfile -EncodedCommand $([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($s)))"`;
}

export const remoteSshArgs = (target, script) => ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target,
  `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`];

// A redirected PowerShell writes its errors as CLIXML; ssh writes plain lines.
export function sshFailure(target, error, stderr) {
  const text = String(stderr);
  const reason = text.startsWith("#< CLIXML") ? /<S S="Error">([^<]*)<\/S>/.exec(text)?.[1].replace(/_x000D__x000A_/g, "") : text.trim().split(/\r?\n/).pop();
  return new Error(`ssh ${target} failed: ${reason?.trim() || (error.killed ? "timed out" : `exit ${error.code}`)}`);
}

/** Runs a PowerShell script on the host over ssh with `input` on its stdin. */
export function runSsh(target, script, input = "", timeout = OPEN_MS) {
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", remoteSshArgs(target, script), { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(sshFailure(target, error, stderr));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function remoteCwd(cwd, host) {
  if (cwd === undefined) return host.root;
  if (!/^[A-Za-z]:[\\/]/.test(cwd) || /\p{Cc}/u.test(cwd)) throw new Error(`Invalid terminal folder on ${host.name}`);
  return cwd.replace(/\//g, "\\");
}

const probeScript = (host) => [
  "Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue",
  `$hash = try { [IO.File]::ReadAllText(${quoteWindows(`${host.root}\\bin\\${BIN_HASH}`)}).Trim() } catch { '' }`,
  "$account = try { (claude auth status | Out-String | ConvertFrom-Json).email } catch { '' }",
  "@{ free = [int64](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024; hash = $hash; account = [string]$account } | ConvertTo-Json -Compress",
].join("\n");

const pushScript = (host) => [
  "$ErrorActionPreference = 'Stop'",
  `$bin = ${quoteWindows(`${host.root}\\bin`)}`,
  "New-Item -ItemType Directory -Force $bin | Out-Null",
  "$files = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "foreach ($file in $files) { [IO.File]::WriteAllBytes((Join-Path $bin $file.name), [Convert]::FromBase64String($file.data)) }",
].join("\n");

export function createRemoteHosts({ hosts, ssh = runSsh, now = Date.now }) {
  return {
    /** Probes the host, refuses another account or too little memory, refreshes its bin and returns the typed launch line. */
    async open({ name, command, cwd, slot }) {
      const args = remoteArgs(command);
      const host = remoteHost(name, await hosts());
      const dir = remoteCwd(cwd, host);
      const deadline = now() + OPEN_MS;
      const probe = JSON.parse(await ssh(host.ssh, probeScript(host), "", OPEN_MS));
      if (String(probe.account).toLowerCase() !== host.account) throw new Error(`claude on ${name} is signed in to another account.`);
      const needed = RESERVE + PANE_MEMORY * (1 + slot.starting);
      if (!(probe.free >= needed)) throw new Error(`Not enough free memory on ${name} (${gb(probe.free)} GB free, ${gb(needed)} GB needed). Close a finished pane there or use another host.`);
      const files = orbitBinFiles(`${host.root}\\bin`).map(([file, content]) => ({ name: file, data: Buffer.from(content).toString("base64") }));
      const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
      // The hash goes last, so an interrupted push is redone on the next open.
      if (probe.hash !== hash) await ssh(host.ssh, pushScript(host), JSON.stringify([...files, { name: BIN_HASH, data: Buffer.from(hash).toString("base64") }]), Math.max(1, deadline - now()));
      return remoteLaunchLine({ host, port: slot.port, cwd: dir, args });
    },
  };
}
