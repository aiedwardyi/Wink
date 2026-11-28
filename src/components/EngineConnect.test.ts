import "./ProfileFields.test-dom.ts";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistPreference, I18nProvider } from "@/lib/i18n";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import type { InstanceInfo } from "@/state/store";
import { Onboarding } from "./Onboarding";
import { NoEngines } from "./NoEngines";
import { EngineConnect } from "./EngineConnect";
import { PRIMARY_BUTTON } from "@/lib/button-style";
import { landFold, spyReveal } from "./Fold.test-land";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { registerEngineInstall, type InstallHandler } from "../../electron/engine-install.mjs";
import { openInstallTerminal } from "../../electron/terminal-launch.mjs";

let instances: InstanceInfo[];
let host: HTMLDivElement;
let root: Root | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const refreshInstances = vi.fn(async (_mode?: boolean | "passive") => {});
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances }, refreshInstances }),
}));

const fleet = () => [
  ["claude", "claudeAgent", "Claude"], ["codex", "codex", "Codex"],
  ["grok", "grokAgent", "Grok"], ["antigravity", "antigravityAgent", "Gemini (Antigravity)"],
  ["muse", "museAgent", "Meta Muse"],
].map(([instanceId, driverKind, displayName]): InstanceInfo => ({
  instanceId, driverKind, displayName, snapshot: { state: "unavailable" }, models: { default: "", options: [] },
  install: { command: { win32: `install-${instanceId}`, linux: `install-${instanceId}` },
    signInCommand: `${instanceId} login`, docsUrl: `https://example.com/${instanceId}` },
}));

async function render(view: ReactElement = createElement(Onboarding, { onDone: vi.fn() })) {
  root ??= createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, view)));
}

async function click(label: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

async function press(row: Element) {
  await act(async () => row.querySelector("button")!.click());
}

async function connect() {
  await render();
  await click("Connect an Engine");
}

const nameRow = (row: Element) => row.querySelector("svg")!.closest("div")!;

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  instances = fleet();
  host = document.createElement("div");
  document.body.append(host);
  vi.stubGlobal("localStorage", window.localStorage);
  persistPreference("en");
  vi.useFakeTimers();
  Object.assign(window, { ogb: { platform: "win32", openEngineInstall: vi.fn(async () => "running"),
    openEngineSignIn: vi.fn(async () => "running") } });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/bots?messages=0" ? { bots: [] } : { instances })));
  vi.stubGlobal("fetch", fetchMock);
  refreshInstances.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.assign(window, { ogb: undefined });
});

describe("first engine connection", () => {
  it.each(["en", "ko"] as const)("keeps installed CLI sign-in when Main is signed out in %s", async (locale) => {
    persistPreference(locale);
    const base = { ...instances[0]!, accountOf: "claude", accountState: "ready" as const,
      snapshot: { state: "available" as const, authenticated: false, version: "1.0" },
      pickerSnapshot: { state: "unavailable" as const } };
    const main = { ...base, instanceId: "acct_00000000-0000-0000-0000-000000000000", accountMain: true };
    instances = [main, base, ...instances.slice(1)];
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const row = host.querySelector('[data-engine-connect="claude"]')!;
    const label = locale === "en" ? "ClaudeSign In" : "Claude로그인";
    expect(row.querySelector("button")?.textContent).toBe(label);
    expect(row.hasAttribute("data-onboarding-ready")).toBe(false);
    expect(host.querySelectorAll("[data-engine-connect]")).toHaveLength(5);
    await click(locale === "en" ? "Show Commands" : "명령어 보기");
    const setup = host.querySelector("[data-engine-connect-commands]")!.firstElementChild!;
    expect(setup.textContent).toContain(locale === "en" ? "Sign in to Claude" : "Claude에 로그인");
    expect(setup.querySelector("code")?.textContent).toBe("claude login");
    expect(setup.textContent).not.toContain(locale === "en" ? "Install Claude" : "Claude 설치");
    await click(label, row);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/instances/${main.instanceId}/sign-in`,
      expect.objectContaining({ method: "POST", body: '{"device":false}' }));
    expect(window.ogb!.openEngineInstall).not.toHaveBeenCalled();
    expect(base.snapshot).toEqual({ state: "available", authenticated: false, version: "1.0" });
  });

  it.each(["en", "ko"] as const)("signs in the Main account copy, not the base account, in %s", async (locale) => {
    persistPreference(locale);
    const id = "acct_11111111-1111-1111-1111-111111111111";
    const base = { ...instances[0]!, accountOf: "claude", snapshot: { state: "available" as const, authenticated: true, version: "1.0" },
      pickerSnapshot: { state: "unavailable" as const } };
    const main = { ...base, instanceId: id, accountMain: true, accountState: "ready" as const,
      snapshot: { state: "available" as const, authenticated: false, version: "1.0" }, pickerSnapshot: undefined };
    instances = [base, main, ...instances.slice(1)];
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const row = () => host.querySelector('[data-engine-connect="claude"]')!;
    const label = locale === "en" ? "ClaudeSign In" : "Claude로그인";
    expect(host.querySelectorAll("[data-engine-connect]")).toHaveLength(5);
    await click(label, row());
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/instances/${id}/sign-in`, expect.objectContaining({ method: "POST" }));
    await click(locale === "en" ? "Show Commands" : "명령어 보기");
    await click(locale === "en" ? "Open Sign-in in Terminal" : "터미널에서 로그인", host.querySelector("[data-engine-connect-commands]")!);
    expect(window.ogb!.openEngineSignIn).toHaveBeenCalledExactlyOnceWith(id);

    instances = [{ ...base, pickerSnapshot: { state: "available", authenticated: true } }, { ...main, snapshot: { ...main.snapshot, authenticated: true } }, ...instances.slice(2)];
    await advance(2000);
    expect(refreshInstances).toHaveBeenCalled();
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    expect(row().hasAttribute("data-onboarding-ready")).toBe(true);
    expect(row().textContent).toContain(locale === "en" ? "Claude is ready" : "Claude 준비 완료");
  });

  it.each([false, true])("uses Main readiness without losing CLI installation (base signed in: %s)", async (authenticated) => {
    const base = { ...instances[0]!, snapshot: { state: "available" as const, authenticated },
      pickerSnapshot: { state: authenticated ? "unavailable" as const : "available" as const, authenticated: !authenticated } };
    await render(createElement(EngineConnect, { instances: [base], onRefresh: refreshInstances }));
    const row = host.querySelector('[data-engine-connect="claude"]')!;
    expect(row.querySelector("button")?.textContent).toBe(authenticated ? "ClaudeSign In" : "Claude is ready");
    expect(row.hasAttribute("data-onboarding-ready")).toBe(!authenticated);
    await click("Show Commands");
    if (authenticated) expect(host.querySelector("code")?.textContent).toBe("claude login");
    expect(base.snapshot.authenticated).toBe(authenticated);
  });

  it("offers a remote start when the added Main account is waiting for its own PC browser", async () => {
    Object.assign(window, { ogb: undefined });
    vi.stubGlobal("location", new URL("https://remote.example/"));
    const base = { ...instances[0]!, accountOf: "claude", accountState: "ready" as const,
      install: { ...instances[0]!.install, login: { args: ["auth", "login"], deviceArgs: ["auth", "login", "--claudeai"] } },
      snapshot: { state: "available" as const, authenticated: true }, pickerSnapshot: { state: "unavailable" as const } };
    const main = { ...base, instanceId: "acct_11111111-1111-1111-1111-111111111111", accountMain: true,
      loginState: "pending" as const, loginOpensBrowser: true, snapshot: { state: "available" as const, authenticated: false } };
    instances = [base,main];
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const row = host.querySelector('[data-engine-connect="claude"]')!;
    expect(row.textContent).toContain("Sign In");
  });

  it("offers Sign In in the already-open remote Main row when the new attempt opens a PC browser", async () => {
    Object.assign(window, { ogb: undefined });
    vi.stubGlobal("location", new URL("https://remote.example/"));
    const base = { ...instances[0]!, accountOf: "claude", accountState: "ready" as const,
      install: { ...instances[0]!.install, login: { args: ["auth", "login"], deviceArgs: ["auth", "login", "--claudeai"] } },
      snapshot: { state: "available" as const, authenticated: true }, pickerSnapshot: { state: "unavailable" as const } };
    const main = { ...base, instanceId: "acct_11111111-1111-1111-1111-111111111111", accountMain: true,
      loginState: "pending" as const, snapshot: { state: "available" as const, authenticated: false } };
    instances = [base, main];
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const row = host.querySelector('[data-engine-connect="claude"]')!;
    expect(row.textContent).toContain("Cancel");
    instances = [base, { ...main, loginOpensBrowser: true }];
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    await advance(2000);
    await advance(2000);
    expect(row.textContent).toContain("Sign In");
    expect(row.textContent).not.toContain("Cancel");
  });

  it("keeps a missing CLI installable even when Main's picker is ready", async () => {
    const base = { ...instances[0]!, pickerSnapshot: { state: "available" as const, authenticated: true } };
    await render(createElement(EngineConnect, { instances: [base], onRefresh: refreshInstances }));
    const row = host.querySelector('[data-engine-connect="claude"]')!;
    expect(row.querySelector("button")?.textContent).toBe("ClaudeInstall");
    expect(row.hasAttribute("data-onboarding-ready")).toBe(false);
    await click("ClaudeInstall", row);
    expect(window.ogb!.openEngineInstall).toHaveBeenCalledExactlyOnceWith("claude");
  });

  it("shows each engine once with four Claude and two Codex accounts", async () => {
    const bases = fleet().map((instance) => ({ ...instance, accountOf: instance.instanceId,
      snapshot: { state: "available" as const, authenticated: true } }));
    instances = [...bases.flatMap((base, index) => Array.from({ length: index === 0 ? 3 : index === 1 ? 1 : 0 }, (_, account) => ({
      ...base, instanceId: `acct_00000000-0000-0000-000${index}-${String(account).padStart(12, "0")}`,
    }))), ...bases];
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    expect([...host.querySelectorAll("[data-engine-connect]")].map((row) => row.getAttribute("data-engine-connect")))
      .toEqual(["claude", "codex", "antigravity", "grok", "muse"]);
  });

  it("leads with Claude and hides the unchanged commands behind Show Commands", async () => {
    await connect();
    expect(host.textContent).toContain("Your bots run on an engine. Most people start with Claude.");
    expect(host.textContent).toContain("A window opens and installs Claude. Then sign in with a paid Claude account.");
    expect(host.textContent).toContain("Other Engines");
    for (const name of ["ChatGPT account", "Google account", "Grok account", "Meta account", "Gemini (Antigravity)"]) {
      expect(host.textContent).toContain(name);
    }
    expect(host.querySelector("code")).toBeNull();
    expect(host.textContent).not.toContain("Check again");
    await click("Show Commands");
    expect(host.querySelector("code")?.textContent).toBe("install-claude");
    expect(host.textContent).toContain("View Setup Guide");
    await click("Show Commands");
    await advance(PRESENCE_EXIT_MS);
    expect(host.querySelector("code")).toBeNull();
  });

  it("brings the first command into view once Show Commands has opened, never while closing", async () => {
    await connect();
    const scrolled = spyReveal();
    try {
      await click("Show Commands");
      expect(scrolled).not.toHaveBeenCalled();
      await landFold(host.querySelector("[data-engine-connect-commands]")!);
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(host.querySelector("[data-engine-connect-commands]")!.firstElementChild);
      expect(scrolled).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
      await click("Show Commands");
      await advance(PRESENCE_EXIT_MS);
      expect(scrolled).toHaveBeenCalledTimes(1);
    } finally {
      scrolled.mockRestore();
    }
  });

  it("polls every five seconds after a click and stops on installation, retaining sign-in and ready states", async () => {
    await connect();
    await advance(15000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click("ClaudeInstall");
    expect(window.ogb!.openEngineInstall).toHaveBeenCalledExactlyOnceWith("claude");
    expect(host.textContent).toContain("Open Again");
    expect(host.textContent).toContain("Finish in the window that opened.");
    await advance(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    instances = instances.map((row) => row.instanceId === "claude" ? { ...row, snapshot: { state: "available", authenticated: false } } : row);
    await advance(1);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/instances?refresh=1");
    expect(host.textContent).toContain("ClaudeSign In");
    expect(host.textContent).not.toContain("Open Again");
    const count = fetchMock.mock.calls.length;
    await advance(15000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    await click("ClaudeSign In");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/instances/claude/sign-in", expect.objectContaining({ method: "POST", body: '{"device":false}' }));
    expect(window.ogb!.openEngineSignIn).not.toHaveBeenCalled();
    instances = instances.map((row) => row.instanceId === "claude" ? { ...row, snapshot: { state: "available", authenticated: true } } : row);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.textContent).toContain("Claude is ready");
    expect(host.querySelector("code")).toBeNull();
  });

  it.each(["running", "opened"] as const)("leaves the button free to open the window again after a %s launch", async (result) => {
    Object.assign(window.ogb!, { openEngineInstall: vi.fn(async () => result) });
    await connect();
    await click("ClaudeInstall");
    const button = () => host.querySelector<HTMLButtonElement>('[data-engine-connect="claude"] button')!;
    expect(button().textContent).toBe("ClaudeOpen Again");
    expect(button().disabled).toBe(false);
    expect(host.textContent).not.toContain("Installing Claude…");
    await click("ClaudeOpen Again");
    expect(window.ogb!.openEngineInstall).toHaveBeenCalledTimes(2);
    expect(button().disabled).toBe(false);
  });

  it("times out at ten minutes, retries with a fresh deadline and still checks on focus", async () => {
    await connect();
    await click("ClaudeInstall");
    await advance(599999);
    expect(host.textContent).toContain("Finish in the window that opened.");
    await advance(1);
    expect(host.textContent).toContain("Didn't finish?");
    const count = fetchMock.mock.calls.length;
    await advance(20000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fetchMock).toHaveBeenCalledTimes(count + 1);
    await click("ClaudeTry Again");
    expect(window.ogb!.openEngineInstall).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(count + 2);
    expect(host.textContent).toContain("Finish in the window that opened.");
  });

  it.skipIf(process.platform !== "win32")("reaches Sign in on the next check when Open Again's window fails and the first window then installs", async () => {
    const temp = mkdtempSync(join(tmpdir(), "wink-retry-fails-"));
    vi.stubEnv("WINK_TEST_INSTALLED", join(temp, "codex.exe"));
    try {
      const handlers = new Map<string, InstallHandler>();
      const windows: { script: string; env?: NodeJS.ProcessEnv }[] = [];
      registerEngineInstall({ handle: (channel, fn) => { handlers.set(channel, fn); } }, {
        trusted: () => true, server: () => ({ port: 1 }), copy: vi.fn(), blank: vi.fn(async () => false),
        fetch: async () => ({ ok: true, json: async () => ({ driverKind: "codex", command: "stub" }) }),
        // The first window installs; Open Again's window fails.
        open: (spec) => openInstallTerminal({ ...spec, command: windows.length ? "Write-Output retry-stub-ran; exit 7" : "Set-Content -LiteralPath $env:WINK_TEST_INSTALLED -Value stub" }, "win32", (_file, args, options) => {
          windows.push({ script: args.at(-1)!, env: options.env });
          const child = new EventEmitter();
          queueMicrotask(() => child.emit("spawn"));
          return child;
        }),
      });
      const run = (index: number) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", windows[index]!.script], { encoding: "utf8", windowsHide: true, timeout: 30000, env: windows[index]!.env ?? process.env });
      Object.assign(window.ogb!, { openEngineInstall: (id: string) => handlers.get("engine:install")!({}, id) });
      fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url === "/api/bots?messages=0" ? { bots: [] } : {
        instances: instances.map((row) => row.instanceId === "codex" && existsSync(process.env.WINK_TEST_INSTALLED!) ? { ...row, snapshot: { state: "available", authenticated: false } } : row),
      })));
      await connect();
      const row = () => host.querySelector('[data-engine-connect="codex"]')!;
      await press(row());
      await advance(11000);
      await press(row());
      expect(windows).toHaveLength(2);
      const retry = run(1);
      expect(retry.stdout).toContain("retry-stub-ran");
      expect(retry.stdout).toContain("The install didn't finish.");
      await advance(5000);
      expect(run(0).status).toBe(0);
      await advance(5000);
      expect(row().textContent).toContain("Sign in to Codex");
    } finally {
      vi.unstubAllEnvs();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps polling after a failed recheck, without losing the commands escape", async () => {
    await connect();
    await click("ClaudeInstall");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await advance(5000);
    expect(host.textContent).toContain("Finish in the window that opened.");
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await click("Show Commands");
    expect(host.querySelector("code")).not.toBeNull();
  });

  it.each(["codex", "antigravity", "grok", "muse"])("installs %s through the existing path and uses the same row states", async (id) => {
    await connect();
    const row = host.querySelector(`[data-engine-connect="${id}"]`)!;
    expect(row).not.toBeNull();
    await press(row);
    expect(window.ogb!.openEngineInstall).toHaveBeenCalledExactlyOnceWith(id);
    expect(row.textContent).toContain("Finish in the window that opened.");
    instances = instances.map((instance) => instance.instanceId === id ? { ...instance, snapshot: { state: "available", authenticated: false } } : instance);
    await advance(5000);
    expect(host.querySelector(`[data-engine-connect="${id}"]`)!.textContent).toContain(`Sign in to ${id === "antigravity" ? "Gemini (Antigravity)" : instances.find((item) => item.instanceId === id)!.displayName}`);
  });

  it("keeps independent deadlines and stops probing when the last install completes", async () => {
    await connect();
    await click("ClaudeInstall");
    await advance(10000);
    await press(host.querySelector('[data-engine-connect="codex"]')!);
    instances = instances.map((row) => row.instanceId === "claude" ? { ...row, snapshot: { state: "available", authenticated: true } } : row);
    await advance(5000);
    expect(host.textContent).toContain("Claude is ready");
    expect(host.querySelector('[data-engine-connect="codex"]')!.textContent).toContain("Finish in the window that opened.");
    instances = instances.map((row) => ({ ...row, snapshot: { state: "available", authenticated: true } }));
    await advance(5000);
    const count = fetchMock.mock.calls.length;
    await advance(600000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("keeps the five-second cadence when another engine starts between probes", async () => {
    await connect();
    await click("ClaudeInstall");
    await advance(2500);
    await press(host.querySelector('[data-engine-connect="codex"]')!);
    await advance(2500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling and focus rechecks when the screen unmounts", async () => {
    await connect();
    await click("ClaudeInstall");
    await act(async () => root!.unmount());
    root = undefined;
    const count = fetchMock.mock.calls.length;
    await advance(600000);
    window.dispatchEvent(new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("offers retry and commands when the installer and clipboard fail", async () => {
    window.ogb!.openEngineInstall = vi.fn(async () => { throw new Error("No handler registered"); });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await connect();
    await click("ClaudeInstall");
    expect(host.textContent).toContain("Didn't finish?");
    await click("Show Commands");
    expect(host.querySelector("code")?.textContent).toBe("install-claude");
    expect(host.textContent).toContain("Try Again");
  });

  it("opens commands by default in a browser and copies the install command", async () => {
    Object.assign(window, { ogb: undefined });
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await connect();
    expect(host.querySelector("code")?.textContent).toBe("install-claude");
    expect(host.textContent).toContain("Copy Command");
    await click("Copy Command");
    expect(copy).toHaveBeenCalledWith("install-claude");
    await advance(30000);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/instances", "/api/bots?messages=0"]);
  });

  it("shares EngineConnect when an engine was installed before opening", async () => {
    instances[0]!.snapshot = { state: "available", authenticated: false };
    await render();
    await click("Continue");
    expect(host.textContent).toContain("Wink found the engines on this computer.");
    expect(host.querySelector("[data-engine-connect-panel]")).not.toBeNull();
    expect(host.textContent).toContain("ClaudeSign In");
    expect(host.querySelector("code")).toBeNull();
    const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    expect(next.disabled).toBe(false);
    expect(next.className).not.toMatch(/flex-1|w-full/);
    expect(next.parentElement!.textContent).toBe("BackContinue");
    expect(host.textContent).not.toContain("Optional setup");
    instances[0]!.snapshot = { state: "available", authenticated: true };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.textContent).toContain("Claude is ready");
    await click("Continue");
    expect(host.textContent).toContain("You're all set");
    expect(host.textContent).toContain("Open Wink");
  });

  it("shows a ready Codex above Other Engines using the existing row", async () => {
    instances[1]!.snapshot = { state: "available", authenticated: true };
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const row = host.querySelector('[data-engine-connect="codex"]')!;
    expect(row.textContent).toContain("Codex is ready");
    expect(row.hasAttribute("data-onboarding-ready")).toBe(true);
    expect(row.querySelector("button")!.disabled).toBe(true);
    const html = host.innerHTML;
    expect(html.indexOf('data-engine-connect="codex"')).toBeLessThan(html.indexOf("Other Engines"));
    expect(html.indexOf('data-engine-connect="claude"')).toBeGreaterThan(html.indexOf("Other Engines"));
    expect(host.querySelector("code")).toBeNull();
  });

  it("shares the Claude-first desktop NoEngines screen and focus recheck", async () => {
    await render(createElement(NoEngines));
    expect(host.textContent).toContain("ClaudeInstall");
    expect(host.querySelector("code")).toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(refreshInstances).toHaveBeenCalledExactlyOnceWith("passive");
    await click("ClaudeInstall");
    await advance(5000);
    expect(refreshInstances).toHaveBeenCalledTimes(2);
    expect(refreshInstances).toHaveBeenLastCalledWith("passive");
    expect(refreshInstances.mock.calls.every((args) => !args.includes(true))).toBe(true);
  });

  it("keeps an onboarding poll response that takes longer than five seconds, including a focus check", async () => {
    await connect();
    await click("ClaudeInstall");
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 12000));
      return Response.json({ instances: instances.map((row) => row.instanceId === "claude"
        ? { ...row, snapshot: { state: "available", authenticated: true } } : row) });
    });
    await advance(5000);
    await advance(5000);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await advance(7000);
    expect(host.textContent).toContain("Claude is ready");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/instances", "/api/instances?refresh=1"]);
  });

  it("shows paste guidance and commands for a blank terminal, polling until the ten-minute deadline", async () => {
    Object.assign(window.ogb!, { platform: "linux", openEngineInstall: vi.fn(async () => "opened") });
    await connect();
    await click("ClaudeInstall");
    const row = host.querySelector('[data-engine-connect="claude"]')!;
    expect(row.textContent).toContain("Paste the command in Terminal and press Enter.");
    expect(row.textContent).toContain("Open Again");
    expect(row.textContent).not.toContain("Finish in the window that opened.");
    expect(host.querySelector("[data-engine-connect-commands] code")?.textContent).toBe("install-claude");
    await advance(595000);
    expect(fetchMock).toHaveBeenCalledTimes(120);
    await advance(25000);
    expect(fetchMock).toHaveBeenCalledTimes(120);
    expect(row.textContent).toContain("Didn't finish?");
  });

  it.each(["claudeAgent", "codex"])("signs in the configured %s instance through the server", async (kind) => {
    const instance = instances.find((row) => row.driverKind === kind)!;
    const configured = { ...instance, instanceId: `${instance.instanceId} work/profile`,
      snapshot: { state: "available" as const, authenticated: false } };
    await render(createElement(EngineConnect, { instances: [configured], onRefresh: refreshInstances }));
    expect(host.querySelector("[data-sign-in]")?.textContent).toContain(kind === "codex" ? "Sign in to Codex" : "ClaudeSign In");
    await press(host.querySelector("[data-engine-connect]")!);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/instances/${encodeURIComponent(configured.instanceId)}/sign-in`,
      expect.objectContaining({ method: "POST", body: '{"device":false}' }));
    expect(window.ogb!.openEngineSignIn).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex", "grok", "antigravity", "muse"])("renders ready %s as a row with a disabled status pill and no install help", async (id) => {
    const instance = instances.find((row) => row.instanceId === id)!;
    instance.snapshot = { state: "available", authenticated: true };
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const row = host.querySelector(`[data-engine-connect="${id}"]`)!;
    const button = row.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent?.startsWith(`${instance.displayName} is ready`)).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.className).not.toContain(PRIMARY_BUTTON);
    expect(row.className).not.toContain("bg-card");
    expect(row.querySelector("p")).toBeNull();
    expect(host.textContent).not.toContain("A window opens and installs Claude.");
  });

  it.each(["en", "ko"] as const)("shows sign-in help instead of install help for installed Claude in %s", async (locale) => {
    persistPreference(locale);
    instances[0]!.snapshot = { state: "available", authenticated: false };
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const row = host.querySelector('[data-engine-connect="claude"]')!;
    expect(row.querySelector("button")!.textContent).toBe(locale === "en" ? "ClaudeSign In" : "Claude로그인");
    expect(row.textContent).toContain(locale === "en" ? "Claude can answer once you're signed in." : "로그인하면 Claude이(가) 답할 수 있어요.");
    expect(row.textContent).not.toContain(locale === "en" ? "A window opens and installs Claude." : "창이 열리고 Claude를 설치합니다.");
  });

  it.each(["en", "ko"] as const)("shows Claude as its name with one action and no download arrow in %s", async (locale) => {
    persistPreference(locale);
    instances[0]!.snapshot = { state: "available", authenticated: false };
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const button = host.querySelector('[data-engine-connect="claude"] button')!;
    expect(button.textContent).toBe(locale === "en" ? "ClaudeSign In" : "Claude로그인");
    expect(button.querySelector(".lucide-download")).toBeNull();
    instances[0]!.snapshot = { state: "unavailable" };
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    expect(host.querySelector('[data-engine-connect="claude"] button')!.textContent).toBe(locale === "en" ? "ClaudeInstall" : "Claude설치");
  });

  it.each(["en", "ko"] as const)("keeps each engine's name on one row with Cancel while signing in and once connected in %s", async (locale) => {
    persistPreference(locale);
    for (const instance of instances.slice(0, 2)) instance.snapshot = { state: "available", authenticated: false };
    let signedIn = false;
    fetchMock.mockImplementation(async (url: string) => Response.json(url === "/api/instances"
      ? { instances: instances.map((row) => row.instanceId === "claude" && signedIn ? { ...row, snapshot: { state: "available", authenticated: true } } : { ...row, loginState: "pending" }) }
      : { url: "https://auth.example/sign-in" }));
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const claude = host.querySelector('[data-engine-connect="claude"]')!;
    const codex = host.querySelector('[data-engine-connect="codex"]')!;
    await press(claude);
    await press(codex);
    const cancel = locale === "en" ? "Cancel" : "취소";
    const openAgain = locale === "en" ? "Open Again" : "다시 열기";
    for (const [row, name] of [[claude, "Claude"], [codex, "Codex"]] as const) {
      expect(row.querySelector("[data-sign-in]")).toBeNull();
      expect(row.textContent).toBe(`${name}${openAgain}${cancel}`);
      expect(nameRow(row).textContent).toBe(`${name}${openAgain}${cancel}`);
      expect(nameRow(row).querySelector("a")?.textContent).toBe(openAgain);
    }
    signedIn = true;
    await advance(2000);
    expect(nameRow(claude).textContent).toBe(`Claude${locale === "en" ? "Connected" : "연결됨"}`);
    expect(nameRow(codex).textContent).toBe(`Codex${openAgain}${cancel}`);
  });

  it("keeps the browser code form under the signing-in row, not inside it", async () => {
    instances[0]!.snapshot = { state: "available", authenticated: false };
    fetchMock.mockImplementation(async (url: string) => Response.json(url === "/api/instances" ? { instances } : { url: "https://auth.example/sign-in", inputGeneration: 1 }));
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const claude = host.querySelector('[data-engine-connect="claude"]')!;
    await press(claude);
    expect(nameRow(claude).textContent).toBe("ClaudeOpen AgainCancel");
    expect(claude.querySelector("form")!.parentElement).toBe(nameRow(claude).parentElement);
  });

  it.each(["en", "ko"] as const)("names the computer-only rows on a phone in %s", async (locale) => {
    persistPreference(locale);
    Object.assign(window, { ogb: undefined });
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    for (const id of ["claude", "antigravity"]) instances.find((row) => row.instanceId === id)!.snapshot = { state: "available", authenticated: false };
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const computer = locale === "en" ? "Sign in on computer" : "컴퓨터에서 로그인";
    for (const [id, name] of [["claude", "Claude"], ["antigravity", "Gemini (Antigravity)"]]) {
      expect(nameRow(host.querySelector(`[data-engine-connect="${id}"]`)!).textContent).toBe(`${name}${computer}`);
    }
  });

  it("keeps Show Commands as its own small link, out of the Back and Continue row", async () => {
    instances[0]!.snapshot = { state: "available", authenticated: false };
    await render();
    await click("Continue");
    const commands = [...host.querySelectorAll("button")].find((button) => button.textContent === "Show Commands")!;
    const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    expect(commands.closest("div")!.contains(next)).toBe(false);
    expect(next.closest("[data-engine-connect-panel] > div:last-child")!.textContent).toContain("Back");
  });

  it("resets the connect session on Back after an engine becomes available", async () => {
    await connect();
    instances[0]!.snapshot = { state: "available", authenticated: false };
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click("Back");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Continue")).toBe(true);
    await click("Continue");
    expect(host.textContent).toContain("Wink found the engines on this computer.");
  });

  it("uses the configured Antigravity display name", async () => {
    instances.find((row) => row.driverKind === "antigravityAgent")!.displayName = "Gemini Work";
    await connect();
    const row = host.querySelector('[data-engine-connect="antigravity"]')!;
    expect(row.textContent).toContain("Gemini Work");
    expect(row.textContent).not.toContain("Gemini (Antigravity)");
  });

  it("lays NoEngines out like a sign-in page: Wink logo, Claude first, every engine as the same outlined row", async () => {
    await render(createElement(NoEngines));
    const main = host.querySelector("main")!;
    expect(main.querySelector('svg[aria-label="Wink"]')).not.toBeNull();
    const buttons = [...main.querySelectorAll<HTMLButtonElement>("[data-engine-connect] button")];
    expect(buttons.some((button) => button.className.includes(PRIMARY_BUTTON))).toBe(false);
    for (const [index, name] of ["ClaudeInstall", "Install Codex", "Install Gemini (Antigravity)", "Install Grok", "Install Meta Muse"].entries()) {
      const button = buttons[index]!;
      expect(button.textContent).toContain(name);
      expect(button.className).toContain("w-full");
      expect(button.className).toContain("border");
      expect(button.querySelector("svg")).not.toBeNull();
    }
  });

  it.each(["en", "ko"] as const)("shows only the phone copy in %s, with no commands or polling", async (locale) => {
    persistPreference(locale);
    Object.assign(window, { ogb: undefined });
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    await render(createElement(NoEngines));
    expect(host.textContent).toContain(locale === "en"
      ? "Your bots run on an engine. Install one in Wink on your PC. Most people start with Claude."
      : "봇은 엔진으로 작동합니다. PC의 Wink에서 엔진을 설치하세요. 대부분 Claude로 시작합니다.");
    expect(host.querySelector("code")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector('svg[aria-label="Wink"]')).not.toBeNull();
    await advance(600000);
    expect(refreshInstances).not.toHaveBeenCalled();
  });
});
