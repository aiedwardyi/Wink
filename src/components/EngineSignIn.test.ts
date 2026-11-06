import "./ProfileFields.test-dom.ts";
import { act, createElement, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider, persistPreference } from "@/lib/i18n";
import { StoreProvider, type InstanceInfo } from "@/state/store";
import { EngineSignIn } from "./EngineSetup";
import { EngineRow as EngineRowView } from "./EnginesSettings";
import { ProviderRegistry } from "../../server/harness/registry.ts";
import { makeFakeDriver } from "../../server/testing/fake-driver.ts";

function EngineRow(props: ComponentProps<typeof EngineRowView>) {
  return createElement(StoreProvider, null, createElement(EngineRowView, props));
}

let root: Root | undefined;
let host: HTMLDivElement;
const capture = { url: "https://auth.example/device", code: "ABCD-EFGH" };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

function instance(kind = "codex", partial: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId: kind, driverKind: kind, displayName: kind,
    snapshot: { state: "available", authenticated: false },
    models: { default: "", options: [] }, cliDefault: kind,
    install: { login: { args: ["login"], deviceArgs: ["login", "--device-auth"] }, logout: ["logout"], signInCommand: `${kind} login`, docsUrl: "https://example.com/guide" },
    ...partial,
  };
}

async function render(element: ReactElement) {
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, element)));
}

async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  applyLocale("en");
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  Object.assign(window, { ogb: undefined });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
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

describe("engine sign-in row", () => {
  it.each(["claudeAgent", "codex"])("offers Sign In after an inconclusive %s registry probe", async (kind) => {
    const registry = new ProviderRegistry([makeFakeDriver({ kind }).driver]);
    try {
      await registry.load({ [kind]: { driver: kind } });
      registry.get(kind)!.snapshot = async () => ({ state: "available" });
      const [row] = await registry.describe();
      vi.stubGlobal("fetch", vi.fn(async () => json(capture)));
      await render(createElement(EngineSignIn, { instance: instance(kind, { snapshot: row.snapshot }) }));
      expect(host.textContent).toBe("Sign In");
      await click("Sign In");
      expect(fetch).toHaveBeenCalledWith(`/api/instances/${kind}/sign-in`, expect.objectContaining({ method: "POST" }));
    } finally { await registry.disposeAll(); }
  });

  it("keeps Linux Gemini sign-in available after an unsupported authentication probe", async () => {
    Object.assign(window, { ogb: { platform: "linux", openEngineSignIn: vi.fn(async () => "opened") } });
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    const row = instance("antigravityAgent", { instanceId: "antigravity", snapshot: { state: "available", authChecked: true } });
    await render(createElement(EngineRow, { instance: row }));
    expect(host.textContent).toContain("Sign In");
    await click("Sign In");
    expect(fetchMock).toHaveBeenCalledWith("/api/instances/antigravity/sign-in", expect.objectContaining({ method: "POST" }));
    expect(window.ogb!.openEngineSignIn).toHaveBeenCalledExactlyOnceWith("antigravity");
  });

  it("keeps Windows Muse blank until its authentication probe answers", async () => {
    Object.assign(window, { ogb: { platform: "win32" } });
    const row = instance("museAgent", { snapshot: { state: "available" } });
    await render(createElement(EngineRow, { instance: row }));
    expect(host.textContent).not.toContain("Sign In");
    expect(host.textContent).not.toContain("Connected");
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineRow, { instance: { ...row, snapshot: { state: "available", authenticated: true } } }))));
    expect(host.textContent).toBe("museAgentSign Out");
    expect(host.textContent).not.toContain("Sign In");
  });

  it.each(["claudeAgent", "codex", "grokAgent", "museAgent", "antigravityAgent"])("leaves the %s action empty until authentication is known", async (kind) => {
    const row = instance(kind, { snapshot: { state: "available" } });
    await render(createElement(EngineSignIn, { instance: row }));
    expect(host.textContent).toBe("");
    expect(host.querySelector("button")).toBeNull();
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: { ...row, snapshot: { state: "available", authenticated: true } } }))));
    expect(host.textContent).toBe("Connected");
  });

  it("cancels immediately and ignores pending pushes until a new sign-in", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn((_: string, init?: RequestInit) => init?.method === "DELETE"
      ? new Promise<Response>((resolve) => { finish = resolve; }) : Promise.resolve(json(capture)));
    vi.stubGlobal("fetch", fetchMock);
    const row = instance("claudeAgent");
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    await click("Cancel");
    expect(host.textContent).toBe("Sign In");
    const push = async (loginState: InstanceInfo["loginState"]) => act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: { ...row, loginState, loginCapture: capture } }))));
    await push("pending");
    expect(host.textContent).toBe("Sign In");
    await act(async () => finish(json({})));
    await push("pending");
    expect(host.textContent).toBe("Sign In");
    await push("cancelled");
    await act(async () => vi.advanceTimersByTimeAsync(7000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await click("Sign In");
    expect(host.textContent).toContain("Cancel");
  });

  it.each(["en", "ko"] as const)("uses the same browser-code hint in shared sign-in surfaces in %s", async (locale) => {
    vi.stubGlobal("localStorage", window.localStorage);
    persistPreference(locale);
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    await render(createElement(EngineSignIn, { instance: instance("claudeAgent", {
      loginState: "pending", loginCapture: { url: "https://example.com/login", inputGeneration: 1 },
    }) }));
    expect(host.querySelector("input")?.placeholder).toBe(locale === "en" ? "Paste the code here" : "여기에 코드를 붙여넣으세요");
    expect(host.textContent).toContain(locale === "en" ? "Sign in with your browser" : "브라우저로 로그인하세요");
    persistPreference("en");
  });

  it("keeps stopped credentials actionable until the account is ready", async () => {
    const row = instance("claudeAgent", { accountState: "stopped", snapshot: { state: "available", authenticated: true } });
    const fetchMock = vi.fn(async (url: string) => json(url === "/api/instances" ? { instances: [{ ...row, loginState: "pending", loginCapture: capture }] } : capture));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: row }));
    expect(host.textContent).toBe("Sign In");
    await click("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toContain(capture.code);
    expect(host.textContent).not.toContain("Connected");
    fetchMock.mockImplementation(async () => json({ instances: [{ ...row, accountState: "ready" }] }));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toBe("Connected");
  });

  it("runs desktop login without opening a second browser, then cancels", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(capture));
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(window, "open");
    await render(createElement(EngineSignIn, { instance: instance() }));
    await click("Sign In");
    expect(fetchMock.mock.calls[0]).toEqual(["/api/instances/codex/sign-in", expect.objectContaining({ method: "POST", body: '{"device":false}' })]);
    expect(host.textContent).toContain("Enter this code in your browser");
    expect(host.textContent).toContain(capture.code);
    expect(host.querySelector("a")?.href).toBe(capture.url);
    expect(host.querySelector("a")?.textContent).toBe("Open Again");
    expect(open).not.toHaveBeenCalled();
    await click("Cancel");
    expect(fetchMock.mock.calls.at(-1)).toEqual(["/api/instances/codex/sign-in", expect.objectContaining({ method: "DELETE" })]);
    expect(host.textContent).toBe("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes every two seconds only while waiting and connects automatically", async () => {
    const row = instance();
    const fetchMock = vi.fn(async (url: string) => json(url === "/api/instances" ? { instances: [{ ...row, snapshot: { state: "available", authenticated: true } }] } : capture));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(host.textContent).toBe("Connected");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resets the pending flow and stops polling when switching engines", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(capture));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: instance() }));
    await click("Sign In");
    expect(host.textContent).toContain(capture.code);
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: instance("grokAgent") }))));
    expect(host.textContent).toBe("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click("Sign In");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/instances/grokAgent/sign-in");
  });

  it("clears a failed flow when switching engines", async () => {
    await render(createElement(EngineSignIn, { instance: instance("codex", { loginState: "failed" }) }));
    expect(host.textContent).toContain("Didn't finish");
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: instance("grokAgent") }))));
    expect(host.textContent).toBe("Sign In");
  });

  it("clears the copied fallback when switching to another pending engine", async () => {
    Object.assign(window, { ogb: { platform: "win32", openEngineSignIn: vi.fn(async () => "copied" as const) } });
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    await render(createElement(EngineSignIn, { instance: instance("antigravityAgent", { install: { signInCommand: "agy" } }) }));
    await click("Sign In");
    expect(host.querySelector("code")?.textContent).toBe("agy");
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: instance("grokAgent", { loginState: "pending", loginCapture: capture }) }))));
    expect([...host.querySelectorAll("code")].map((node) => node.textContent)).toEqual([capture.code]);
  });

  it("ignores the previous engine's late start response after switching", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await render(createElement(EngineSignIn, { instance: instance() }));
    await click("Sign In");
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: instance("grokAgent", { loginState: "pending" }) }))));
    await act(async () => finish(json(capture)));
    expect(host.querySelector("code, a")).toBeNull();
    expect(host.textContent).toContain("Cancel");
  });

  it.each(["codex", "grokAgent", "museAgent"])("uses the phone device flow for %s", async (kind) => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(capture));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: instance(kind) }));
    await click("Sign In");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: '{"device":true}' });
    expect(host.textContent).toContain(capture.code);
    expect(host.textContent).toContain("Enter this code in your browser");
    expect(host.querySelector("a")?.textContent).toBe("Open Link");
  });

  it("offers Open Link when desktop Muse opened nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(capture)));
    await render(createElement(EngineSignIn, { instance: instance("museAgent", { install: { login: { args: ["login"], deviceArgs: ["login"] } } }) }));
    await click("Sign In");
    expect(host.querySelector("a")?.textContent).toBe("Open Link");
    expect(host.textContent).toContain("Enter this code in your browser");
  });

  it.each(["claudeAgent", "antigravityAgent"])("keeps %s on the computer without relaying a code", async (kind) => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    await render(createElement(EngineSignIn, { instance: instance(kind, { install: { login: { args: ["login"] } }, loginState: "pending", loginCapture: capture }) }));
    expect(host.textContent).toBe("Sign in on a computer");
    expect(host.querySelector("button, a, code")).toBeNull();
  });

  it("opens the agy terminal with its id and polls until connected", async () => {
    const openEngineSignIn = vi.fn(async () => "running" as const);
    Object.assign(window, { ogb: { platform: "win32", openEngineSignIn } });
    const row = instance("antigravityAgent", { install: { signInCommand: "agy" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url === "/api/instances" ? { instances: [{ ...row, snapshot: { state: "available", authenticated: true } }] } : {})));
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    expect(openEngineSignIn).toHaveBeenCalledExactlyOnceWith("antigravityAgent");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toBe("Connected");
  });

  it("shows retry when the server reports failure or timeout", async () => {
    const row = instance();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url === "/api/instances" ? { instances: [{ ...row, loginState: "failed" }] } : capture)));
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toContain("Didn't finish. Try again.");
    expect(host.textContent).toContain("Sign In");
    expect(host.textContent).not.toContain(capture.code);
  });

  it.each(["copied", "no bridge"])("keeps waiting with the agy command after %s", async (mode) => {
    const openEngineSignIn = vi.fn(async () => "copied" as const);
    if (mode === "copied") Object.assign(window, { ogb: { platform: "win32", openEngineSignIn } });
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const row = instance("antigravityAgent", { install: { signInCommand: "agy" } });
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => json(url === "/api/instances"
      ? { instances: [{ ...row, snapshot: { state: "available", authenticated: true } }] } : {}));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    expect(host.querySelector("code")?.textContent).toBe("agy");
    expect(host.textContent).toContain("Cancel");
    expect(host.querySelector("span")?.textContent).toBe("Paste the command in Terminal and press Enter.");
    expect(host.textContent).not.toContain("Finish in your browser");
    expect(host.textContent).not.toContain("Didn't finish");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    if (mode === "no bridge") expect(copy).toHaveBeenCalledWith("agy");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toBe("Connected");
  });

  it("shows why sign-in could not start and leaves the other sign-in running", async () => {
    const reasons = [
      ["login-busy", "Another sign-in is still open. Finish or cancel it first.", "다른 로그인이 아직 진행 중이에요. 먼저 끝내거나 취소하세요."],
      ["account-busy", "Finish this account's running work, then sign in.", "이 계정에서 실행 중인 작업이 끝난 뒤 로그인하세요."],
      ["host-unknown", "Can't check this account's workers right now. Try again in a moment.", "지금은 이 계정의 작업을 확인할 수 없어요. 잠시 후 다시 시도하세요."],
      [undefined, "Didn't finish. Try again.", "완료되지 않았어요. 다시 시도하세요."],
    ] as const;
    vi.stubGlobal("localStorage", window.localStorage);
    for (const locale of ["en", "ko"] as const) {
      persistPreference(locale);
      for (const [code, en, ko] of reasons) {
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
          ? new Response(JSON.stringify({ error: "Sign-in is busy", ...code && { code } }), { status: 409 }) : json({}));
        vi.stubGlobal("fetch", fetchMock);
        await render(createElement(EngineSignIn, { instance: instance("claudeAgent") }));
        await click(locale === "en" ? "Sign In" : "로그인");
        expect(host.textContent, code).toContain(locale === "en" ? en : ko);
        expect(host.textContent).not.toContain("Sign-in is busy");
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"), code).toEqual([]);
        await act(async () => root!.unmount());
      }
    }
    persistPreference("en");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Promise.reject(new TypeError("Failed to fetch")) : json({}));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: instance("claudeAgent") }));
    await click("Sign In");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"), "no answer: cancel the half-started sign-in").toHaveLength(1);
  });

  it("keeps a still-authenticated engine signed in after failed sign-out without polling", async () => {
    const row = instance("museAgent", { snapshot: { state: "available", authenticated: true } });
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/sign-out")
      ? new Response(JSON.stringify({ error: "Sign-out failed" }), { status: 502 })
      : json({ instances: [row], candidates: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineRowView, { instance: row }));
    await click("Sign Out");
    expect([...host.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Sign Out"]);
    expect(host.textContent).toContain("Didn't finish");
    const calls = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("ignores a late start response after cancellation", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_: string, init: RequestInit) => init.method === "POST" ? new Promise<Response>((resolve) => { finish = resolve; }) : Promise.resolve(json({}))));
    await render(createElement(EngineSignIn, { instance: instance() }));
    await click("Sign In");
    await click("Cancel");
    await act(async () => finish(json(capture)));
    expect(host.textContent).toBe("Sign In");
  });

  it("signs out from the connected row with no path or terminal controls", async () => {
    let signedOut = false;
    const row = instance("codex", { snapshot: { state: "available", authenticated: true } });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/sign-out")) signedOut = true;
      return json(url.startsWith("/api/instances?") ? { instances: [{ ...row, snapshot: { state: "available", authenticated: !signedOut } }] } : {});
    });
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineRow, { instance: row }));
    expect(host.textContent).toBe("codexSign Out");
    expect(host.querySelector("input, select, code, a")).toBeNull();
    await click("Sign Out");
    expect(fetchMock).toHaveBeenCalledWith("/api/instances/codex/sign-out", expect.objectContaining({ method: "POST", body: "{}" }));
    expect(host.textContent).toContain("Sign In");
    expect(host.textContent).not.toContain("Connected");
  });

  it("offers only Sign In for a signed-out engine", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ candidates: [] })));
    await render(createElement(EngineRow, { instance: instance() }));
    expect([...host.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Sign In"]);
    expect(host.textContent).not.toContain("codex login");
    expect(host.querySelector("input, select, code, a")).toBeNull();
  });

  it("never offers agy sign-out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ candidates: [] })));
    await render(createElement(EngineRow, { instance: instance("antigravityAgent", { snapshot: { state: "available", authenticated: true }, install: { signInCommand: "agy" } }) }));
    expect(host.textContent).toBe("antigravityAgentConnected");
    expect(host.querySelector("button")).toBeNull();
  });
});
