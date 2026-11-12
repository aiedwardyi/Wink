// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { trackOnboard } from "@/lib/usage-stats";
import { Onboarding } from "./Onboarding";

vi.mock("@/lib/usage-stats", async (original) => ({ ...(await original<typeof import("@/lib/usage-stats")>()), trackOnboard: vi.fn() }));

const RETIRED_KINDS = ["grok", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "qwenAgent", "hermesAgent", "openai-compat", "piAgent", "minimax", "opencodeGo"];
let roots: Root[] = [];

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(trackOnboard).mockClear();
  document.body.innerHTML = "";
});

async function renderWith(status: number, onDone = vi.fn(), body: object = { error: "x" }) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone }))));
  return host;
}

function phoneWidth() {
  // SAFETY: isPhone only reads .matches
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") }) as MediaQueryList);
}

describe("Onboarding engine check", () => {
  it.each([false, true])("skips setup on a browser with existing bots (phone %s)", async (phone) => {
    if (phone) phoneWidth();
    const onDone = vi.fn();
    const host = await renderWith(200, onDone, { instances: [], bots: [{ id: "existing" }] });
    expect(onDone).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("");
    expect(fetch).toHaveBeenCalledWith("/api/bots?messages=0");
    expect(trackOnboard).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps setup on a fresh browser (phone %s)", async (phone) => {
    if (phone) phoneWidth();
    const onDone = vi.fn();
    const host = await renderWith(200, onDone, { instances: [], bots: [] });
    expect(host.textContent).toContain("Welcome to Wink");
    expect(onDone).not.toHaveBeenCalled();
    expect(trackOnboard).toHaveBeenCalledExactlyOnceWith("welcome");
  });

  it("keeps desktop setup even when bots exist", async () => {
    vi.stubGlobal("ogb", { platform: "win32" });
    const onDone = vi.fn();
    const host = await renderWith(200, onDone, { instances: [], bots: [{ id: "existing" }] });
    expect(host.textContent).toContain("Welcome to Wink");
    expect(onDone).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/instances");
  });

  it("waits for the browser's bot check without flashing Welcome", async () => {
    let answer!: (response: Response) => void;
    const bots = new Promise<Response>((resolve) => { answer = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path.startsWith("/api/bots") ? bots : Response.json({ instances: [] })));
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    const onDone = vi.fn();
    await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone }))));
    expect(host.textContent).toBe("");
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => answer(Response.json({ bots: [{ id: "existing" }] })));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps sign-in on an unpaired browser (phone %s)", async (phone) => {
    if (phone) phoneWidth();
    const onDone = vi.fn();
    const host = await renderWith(401, onDone);
    expect(host.textContent).toContain("Scan the code on your PC");
    expect(onDone).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/instances");
  });

  it("opens the shell directly when no engine is installed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem("omb-locale", "en");
    const onDone = vi.fn();
    const host = await renderWith(200, onDone, { instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "unavailable" }, models: { default: "", options: [] } }] });
    const click = async (label: string) => {
      const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
      expect(button, label).toBeDefined();
      await act(async () => button!.click());
    };
    await click("Connect an Engine");
    await click("Open Wink");
    expect(onDone).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("You're all set");
  });

  it("keeps the all-set step when an engine is ready", async () => {
    localStorage.setItem("omb-locale", "en");
    const onDone = vi.fn();
    const host = await renderWith(200, onDone, { instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available", authenticated: true }, models: { default: "", options: [] } }] });
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!.click());
    expect(host.textContent).toContain("You're all set");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("updates the ready row and disables Continue when the last engine signs out", async () => {
    let authenticated = false;
    const instance = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] },
      install: { login: { args: ["auth", "login"] }, logout: ["auth", "logout"] },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/sign-out")) authenticated = false;
      return new Response(JSON.stringify({ instances: [{ ...instance, snapshot: { state: "available", authenticated } }] }));
    }));
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone: vi.fn() }))));
    const click = async (label: string) => {
      const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
      expect(button, label).toBeDefined();
      await act(async () => button!.click());
    };
    await click("Continue");
    authenticated = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    const ready = () => host.querySelector("[data-onboarding-ready]");
    const next = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    expect(ready()).not.toBeNull();
    expect(next().disabled).toBe(false);
    authenticated = false;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(ready()).toBeNull();
    expect(next().disabled).toBe(true);
  });

  it.each(["claude", "codex"])("focuses Continue when %s becomes ready on the engine step", async (readyId) => {
    localStorage.setItem("omb-locale", "en");
    const instances = [
      { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
        snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] },
        install: { docsUrl: "https://example.com/claude", signInCommand: "claude auth login" } },
      { instanceId: "codex", driverKind: "codex", displayName: "Codex",
        snapshot: { state: "unavailable", authenticated: false }, models: { default: "", options: [] },
        install: { docsUrl: "https://example.com/codex", command: { win32: "install-codex" } } },
    ];
    const host = await renderWith(200, vi.fn(), { instances });
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!.click());
    const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    expect(next.disabled).toBe(true);
    const ready = instances.map((instance) => ({ ...instance,
      snapshot: { state: instance.instanceId === readyId ? "available" : "unavailable", authenticated: instance.instanceId === readyId },
    }));
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ instances: ready })));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(next.disabled).toBe(false);
    expect(document.activeElement).toBe(next);
    expect(host.textContent).not.toContain("You're all set");
  });

  it("reuses the sign-in row for an installed engine", async () => {
    const instance = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] },
      install: { login: { args: ["auth", "login"] }, signInCommand: "claude auth login" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [instance] }))));
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone: vi.fn() }))));
    const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    await act(async () => next.click());
    expect(host.textContent).toContain("Sign in to Claude");
    expect(host.textContent).not.toContain("Details");
    expect(host.textContent).not.toContain("Open Sign-in in Terminal");
  });
  it("never counts a retired engine a cached probe calls ready", async () => {
    const retired = RETIRED_KINDS.map((driverKind) => ({
      instanceId: driverKind, driverKind, displayName: `Old ${driverKind}`,
      snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [] },
      install: { docsUrl: "https://example.com" },
    }));
    const claude = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "unavailable" }, models: { default: "", options: [] }, install: { docsUrl: "https://claude.com" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [...retired, claude] }))));
    const onDone = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone }))));
    const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "Connect an Engine");
    expect(next).toBeDefined();
    await act(async () => next!.click());
    expect(onDone).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Claude");
    expect(host.textContent).not.toContain("Old ");
  });

  it("asks an unpaired phone to sign in instead of blaming the engines", async () => {
    const host = await renderWith(401);
    expect(host.textContent).toContain("Scan the code on your PC");
    expect(host.textContent).toContain("Settings → Devices.");
    expect(host.textContent).not.toContain("Copy");
    expect(host.querySelector("button")?.textContent).toBe("Try Again");
    expect(host.textContent).not.toContain("couldn't check the engines");
  });

  it("opens a paired phone straight to the chat", async () => {
    phoneWidth();
    const onDone = vi.fn();
    const host = await renderWith(200, onDone, { instances: [], bots: [{ id: "existing" }] });
    expect(onDone).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("");
  });

  it("still asks an unpaired phone to sign in, and welcomes a first launch of the desktop app", async () => {
    phoneWidth();
    expect((await renderWith(401)).textContent).toContain("Scan the code on your PC");
    vi.stubGlobal("ogb", { platform: "win32" });
    const onDone = vi.fn();
    expect((await renderWith(200, onDone)).textContent).toContain("Welcome to Wink");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("still reports a real engine check failure", async () => {
    const host = await renderWith(500);
    expect(host.textContent).toContain("Wink is still getting ready.");
    expect(host.textContent).not.toContain("Sign in to this PC");
  });

  it("reads the last check on open and asks for a fresh probe on retry and on focus", async () => {
    const host = await renderWith(500);
    const fetchMock = vi.mocked(fetch);
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Try again");
    await act(async () => retry!.click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/instances",
      "/api/instances?refresh=1",
      "/api/instances?refresh=1",
    ]);
  });
});
