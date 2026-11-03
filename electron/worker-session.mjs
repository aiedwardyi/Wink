import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const canonical = (cwd) => process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);

export const WORKER_SESSION_PS1 = String.raw`$ErrorActionPreference = 'Stop'
if (-not $env:ORBIT_SESSION_URL -or -not $env:ORBIT_SESSION_AUTH -or -not $env:ORBIT_SESSION_GENERATION) { exit 0 }
try {
  [Console]::InputEncoding = [Text.Encoding]::UTF8
  $text = (Get-Variable -Name input -Scope Script -ValueOnly -ErrorAction SilentlyContinue | ForEach-Object { $_ }) -join ([string][char]10)
  if (-not $text -and [Console]::IsInputRedirected) { $text = [Console]::In.ReadToEnd() }
  $hook = $text | ConvertFrom-Json
  if ($hook.hook_event_name -ne 'SessionStart' -or @('startup','resume') -notcontains $hook.source) { exit 0 }
  $body = @{ pane = $env:ORBIT_PANE; launchGeneration = $env:ORBIT_SESSION_GENERATION; session_id = $hook.session_id; transcript_path = $hook.transcript_path; cwd = $hook.cwd; source = $hook.source } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri $env:ORBIT_SESSION_URL -Method Post -Headers @{ Authorization = "Bearer $env:ORBIT_SESSION_AUTH" } -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
} catch { exit 1 }
exit 0
`;

export function workerSessionHook(dir) {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(dir, "orbit-session.ps1").replace(/\\/g, "/")}"`;
}

export function claudeSessionArgs(args, dir) {
  const hook = { matcher: "startup|resume", hooks: [{ type: "command", command: workerSessionHook(dir), timeout: 15 }] };
  for (let i = args.length - 1; i >= 0; i--) {
    const inline = args[i].startsWith("--settings=");
    if (args[i] !== "--settings" && !inline) continue;
    const value = JSON.parse(inline ? args[i].slice(11) : args[i + 1]);
    const settings = JSON.stringify({ ...value, hooks: { SessionStart: [hook] } });
    args[inline ? i : i + 1] = inline ? `--settings=${settings}` : settings;
    return args;
  }
  return [...args, "--settings", path.join(dir, "claude-worker.json")];
}

export function codexSessionArgs(dir, platform) {
  const command = workerSessionHook(dir);
  const hook = { async: false, command, timeout: 15, type: "command" };
  // Trust only this declaration in the invocation layer, never all discovered hooks.
  const identity = { event_name: "session_start", hooks: [hook], matcher: "startup|resume" };
  const hash = `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  const source = platform === "win32" ? "C:\\<session-flags>\\config.toml" : "/<session-flags>/config.toml";
  const key = `${source}:session_start:0:0`;
  return ["-c", `hooks.SessionStart=[{matcher="startup|resume",hooks=[{type="command",command=${JSON.stringify(command)},timeout=15}]}]`,
    "-c", `hooks.state={${JSON.stringify(key)}={enabled=true,trusted_hash=${JSON.stringify(hash)}}}`];
}

export function createWorkerSession(worker, pane, cwd, bridgeUrl) {
  const launch = worker?.session;
  if (!launch || !["claude", "codex"].includes(launch.engine)) return null;
  const auth = randomBytes(24).toString("hex");
  return {
    auth,
    env: { ORBIT_SESSION_URL: bridgeUrl ? `${bridgeUrl}/v1/terminal/session` : "", ORBIT_SESSION_AUTH: auth, ORBIT_SESSION_GENERATION: launch.launchGeneration },
    run: { pane, launchGeneration: launch.launchGeneration, engine: launch.engine, nativeId: launch.nativeId,
      cwd, accountId: worker.account.id, accountGeneration: worker.account.generation, model: launch.model, effort: launch.effort, lifecycle: "running" },
  };
}

export function captureWorkerSession(sessions, runs, authorization, input) {
  const session = sessions.get(input?.pane);
  const capture = session?.workerSession;
  if (!capture || session.retired || session.workerFinished || session.exitCode !== null || !runs) return false;
  const received = Buffer.from(typeof authorization === "string" ? authorization : "");
  const expected = Buffer.from(`Bearer ${capture.auth}`);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
  return runs.capture(input);
}

export function capturedSession(run, input) {
  const session = run?.session;
  if (!session || run.state !== "running" || input?.pane !== run.id || input.launchGeneration !== session.launchGeneration
    || typeof input.session_id !== "string" || !UUID.test(input.session_id)
    || (session.nativeId && session.nativeId.toLowerCase() !== input.session_id.toLowerCase())
    || typeof input.cwd !== "string" || canonical(input.cwd) !== canonical(session.cwd)
    || !["startup", "resume"].includes(input.source)
    || (input.transcript_path !== null && (typeof input.transcript_path !== "string" || input.transcript_path.length > 4096 || !path.isAbsolute(input.transcript_path)))) return null;
  return { ...session, nativeId: input.session_id, transcriptPath: input.transcript_path, source: input.source };
}
