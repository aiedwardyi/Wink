import { spawn, type ChildProcess } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import { augmentedPath, findCliCandidates, resolveCliSpawn } from "./env-path.ts";
import { cliVersion, killCliTree } from "./procs.ts";
import { accountLaunch, type AccountContext } from "./account-policy.ts";
import { redactSecretsInText } from "./redact.ts";

export interface LoginCapture {
  url?: string;
  code?: string;
  inputGeneration?: number;
  error?: "device_cap";
}

export class LoginBusyError extends Error {
  readonly status = 409;
  readonly code = "login-busy";
  constructor() { super("Another sign-in for this engine is still running"); }
}

/** A sign-in belongs to the session that started it: this PC or a paired phone, plus the browser's own id. */
export function signInOwner(headers: { [name: string]: string | string[] | undefined }, phoneId?: string): string {
  const client = String(headers["x-wink-client"] ?? "");
  return `${phoneId ? `phone:${phoneId}` : "pc"}:${/^[0-9a-f]{32}$/.test(client) ? client : ""}`;
}

export function logSignInRefusal(status: number, code?: string): void {
  console.warn(`sign-in refused code=${code ?? `http-${status}`} status=${status} stderr=-`);
}

function launchErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : "launch-error";
}

function safeStderr(line: string): string {
  return redactSecretsInText(line
    .replace(/\bhttps?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:[\w-]*(?:token|secret|password|api[-_]?key|authorization)|code)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "[credential]")
    .replace(/\bBearer\s+\S+/gi, "[credential]")
    .replace(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4,5}){1,2}\b|[A-Za-z0-9_+\/=-]{24,}/g, "[code]"))
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").slice(0, 320);
}

function logCliExit(code: string, line?: string): void {
  console.warn(`sign-in CLI exit code=${code} stderr=${line ? JSON.stringify(line) : "-"}`);
}

const VERSION_PROBE_MS = 10_000;
const PASTE_PROMPT = /^(?:Paste code here if prompted\s*>|Then paste the authorization code\b.*:)\s*$/;

type LoginState = "pending" | "complete" | "failed" | "cancelled";
interface LoginJob {
  scope: string;
  generation: number;
  child?: ChildProcess;
  capture: LoginCapture;
  state: LoginState;
  done: Promise<void>;
  finish: (state: LoginState) => void;
  changed: Set<() => void>;
  acknowledged: boolean;
  pasteBack: boolean;
  owner?: string;
  lastStderr?: string;
}

export class EngineLogin {
  private jobs = new Map<string, LoginJob>();
  private scopes = new Map<string, LoginJob>();
  private nextGeneration = 0;
  private disposed = false;
  private timeoutMs: number;
  private captureMs: number;

  constructor(timeoutMs = 5 * 60_000, captureMs = 10_000) {
    this.timeoutMs = timeoutMs;
    this.captureMs = captureMs;
  }

  state(engine: string): LoginState | undefined {
    return this.jobs.get(engine)?.state;
  }

  generation(engine: string): number | undefined {
    return this.jobs.get(engine)?.generation;
  }

  async wait(engine: string): Promise<void> {
    await this.jobs.get(engine)?.done;
  }

  capture(engine: string): LoginCapture {
    return { ...this.jobs.get(engine)?.capture };
  }

  /** Whether `owner` may answer or cancel this engine's sign-in: always, unless another session's is pending. */
  owns(engine: string, owner?: string): boolean {
    const job = this.jobs.get(engine);
    return job?.state !== "pending" || job.owner === owner;
  }

  submit(engine: string, generation: number, code: string): boolean {
    const job = this.jobs.get(engine);
    if (job?.state !== "pending" || job.capture.inputGeneration !== generation || !job.child?.stdin?.writable
      || !code.length || code.length > 4096 || /[^!-~]/.test(code)) return false;
    try { job.child.stdin.write(`${code}\n`); } catch { return false; }
    delete job.capture.inputGeneration;
    return true;
  }

  needsRefresh(engine: string): boolean {
    const job = this.jobs.get(engine);
    return job?.state === "pending" || (job?.state === "complete" && !job.acknowledged);
  }

  async start(engine: string, cli: string, args: string[], env: NodeJS.ProcessEnv = {}, authHosts: string[] = [], options: { scope?: string; account?: AccountContext; logExit?: boolean; paste?: boolean; owner?: string } = {}): Promise<LoginCapture> {
    if (this.disposed) return {};
    let job = this.jobs.get(engine);
    const scope = options.scope ?? engine;
    const owner = this.scopes.get(scope);
    if (owner && owner !== job) {
      if (owner.state === "pending") throw new LoginBusyError();
      await owner.done;
      if (this.scopes.get(scope) === owner) throw new LoginBusyError();
      return this.start(engine, cli, args, env, authHosts, options);
    }
    if (job && job.state !== "pending") {
      await job.done;
      if (this.jobs.get(engine) === job) this.jobs.delete(engine);
      return this.start(engine, cli, args, env, authHosts, options);
    }
    if (job?.state !== "pending") {
      job = this.create(engine, scope);
      job.pasteBack = options.paste === true;
      job.owner = options.owner;
      try {
        // A cold Windows sign-in can beat the status check that selects the usable Claude binary.
        if (process.platform === "win32" && scope === "claudeAgent" && cli === "claude" && args[0] === "auth" && args[1] === "login" && findCliCandidates(cli).length > 1) {
          const probeEnv = accountLaunch(options.account, scope, [], { PATH: augmentedPath(), ...env }).env;
          // execFile's timeout can't fire its callback while a shim descendant holds the pipes open, so bound the wait and let cancel end it.
          await new Promise<void>((resolve) => {
            const stop = () => { clearTimeout(bound); job!.changed.delete(stop); resolve(); };
            const bound = setTimeout(stop, VERSION_PROBE_MS);
            job!.changed.add(stop);
            cliVersion(cli, { timeout: 8000, env: probeEnv }, stop);
          });
          if (job.state !== "pending") return { ...job.capture };
        }
        const resolved = resolveCliSpawn(cli, args);
        const launch = accountLaunch(options.account, scope, resolved.args, { PATH: augmentedPath(), ...env });
        const child = spawn(resolved.command, launch.args, {
          stdio: "pipe", windowsHide: true,
          ...(process.platform === "win32" ? {} : { detached: true }),
          env: launch.env,
        });
        job.child = child;
        child.stdin.on("error", () => {});
        this.read(child.stdout, job, authHosts);
        this.read(child.stderr, job, authHosts, options.logExit);
        let spawnError: string | undefined;
        child.once("error", (error) => { spawnError = launchErrorCode(error); job!.finish("failed"); });
        child.once("close", (code, signal) => {
          if (options.logExit && (spawnError || signal || code !== 0)) logCliExit(spawnError ?? signal ?? String(code), job!.lastStderr);
          job!.finish(code === 0 ? "complete" : "failed");
        });
      } catch (error) {
        if (options.logExit) logCliExit(launchErrorCode(error));
        job.finish("failed");
      }
    }
    await this.waitForCapture(job);
    return { ...job.capture };
  }

  waitExternal(engine: string): LoginCapture {
    if (this.disposed) return {};
    if (this.state(engine) !== "pending") this.create(engine);
    return {};
  }

  complete(engine: string): void {
    const job = this.jobs.get(engine);
    if (job?.state === "pending") job.finish("complete");
  }

  acknowledge(engine: string, authenticated: boolean): void {
    const job = this.jobs.get(engine);
    if (job?.state === "complete") {
      job.acknowledged = true;
      if (!authenticated) job.state = "failed";
    }
  }

  clear(engine: string): void {
    this.jobs.delete(engine);
  }

  async cancel(engine: string): Promise<void> {
    const job = this.jobs.get(engine);
    if (!job) return;
    if (job.state === "pending") job.finish("cancelled");
    await job.done;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.jobs.keys()].map((engine) => this.cancel(engine)));
    this.jobs.clear();
    this.scopes.clear();
  }

  private create(engine: string, scope = engine): LoginJob {
    let closed!: () => void;
    const job: LoginJob = {
      scope,
      generation: ++this.nextGeneration,
      capture: {}, state: "pending", changed: new Set(), acknowledged: false, pasteBack: false,
      done: new Promise<void>((resolve) => { closed = resolve; }),
      finish: (state) => {
        if (job.state !== "pending") return;
        job.state = state;
        clearTimeout(timer);
        if (job.child && job.child.exitCode === null && job.child.signalCode === null) {
          let childClosed = false;
          let treeStopped = false;
          const finish = () => {
            if (!childClosed || !treeStopped) return;
            clearTimeout(fallback);
            if (this.scopes.get(scope) === job) this.scopes.delete(scope);
            closed();
          };
          const fallback = setTimeout(() => {
            if (this.scopes.get(scope) === job) this.scopes.delete(scope);
            closed();
          }, 5000);
          fallback.unref();
          job.child.once("close", () => { childClosed = true; finish(); });
          killCliTree(job.child, () => { treeStopped = true; finish(); });
        } else {
          if (this.scopes.get(scope) === job) this.scopes.delete(scope);
          closed();
        }
        for (const notify of job.changed) notify();
      },
    };
    const timer = setTimeout(() => job.finish("failed"), this.timeoutMs);
    timer.unref();
    this.jobs.set(engine, job);
    this.scopes.set(scope, job);
    return job;
  }

  private read(stream: NodeJS.ReadableStream, job: LoginJob, authHosts: string[], stderr = false): void {
    let line = "";
    let dropping = false;
    stream.setEncoding("utf8");
    const parse = () => {
      const clean = stripVTControlCharacters(line).trim();
      if (stderr && clean) job.lastStderr = safeStderr(clean);
      if (job.state !== "pending") { line = ""; return; }
      if (job.pasteBack && PASTE_PROMPT.test(clean)) job.capture.inputGeneration = job.generation;
      if (job.scope === "codex" && /\bdevice[ _-]+limit(?:[ _-]+reached)?\b|\btoo many (?:paid )?accounts (?:on|for) (?:this|the same) device\b/i.test(clean)) {
        job.capture.error = "device_cap";
        job.finish("failed");
      }
      const url = /^(?:(?:If your browser (?:did not|didn't) open, (?:navigate to this URL|visit)|If the browser didn't open, visit|Visit|Open(?: this URL)?|Sign in(?: at)?|URL|Verification (?:URL|URI))\s*:?\s*)?(https:\/\/[^\s<>"\x00-\x1f]+)$/i.exec(clean);
      const code = /^(?:(?:Enter (?:this |the )?(?:one-time |device |user )?code(?: \(expires in \d+ minutes\))?|(?:Your )?(?:one-time |device |user )?code)\s*:?\s*)?([A-Z0-9]{4}(?:-[A-Z0-9]{4,5}){1,2})$/i.exec(clean);
      if (url && !job.capture.url) {
        try {
          const parsed = new URL(url[1]);
          const names = [...parsed.searchParams.keys(), ...new URLSearchParams(parsed.hash.slice(1)).keys()].map((name) => name.toLowerCase());
          const authorization = job.pasteBack && parsed.hostname === "claude.com" && parsed.pathname === "/cai/oauth/authorize"
            && parsed.searchParams.getAll("code").length === 1 && parsed.searchParams.get("code") === "true" && !parsed.hash;
          const secret = names.some((name) => ["access_token", "refresh_token", "id_token", "token"].includes(name))
            || (!authHosts.includes(parsed.hostname) && !authorization && names.includes("code"));
          if (!parsed.username && !parsed.password && !secret) job.capture.url = parsed.href;
        } catch {}
      }
      if (code && !job.capture.code) job.capture.code = code[1];
      for (const notify of job.changed) notify();
      line = "";
    };
    stream.on("data", (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r") {
          if (!dropping) parse();
          line = "";
          dropping = false;
        } else if (!dropping) {
          line += char;
          if (job.pasteBack && char === ">" && /^Paste code here if prompted\s*>$/.test(stripVTControlCharacters(line).trim())) parse();
          if (line.length > 8192) {
            if (stderr) job.lastStderr = "[line too long]";
            line = ""; dropping = true;
          }
        }
      }
    });
    stream.on("end", () => { if (!dropping && line) parse(); line = ""; });
  }

  private waitForCapture(job: LoginJob): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        job.changed.delete(check);
        resolve();
      };
      const check = () => {
        if (job.state !== "pending" || (job.capture.url && (job.capture.code || job.capture.inputGeneration))) finish();
      };
      const timer = setTimeout(finish, this.captureMs);
      job.changed.add(check);
      check();
    });
  }
}
