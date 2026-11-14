// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { api } from "@/state/store";
import { PhoneAccessSettings, resetRelay, warmRelay, type RelayStatus } from "./PhoneAccessSettings";

const request = vi.fn<typeof api>();
const HOST = "abcdefghijklmnop.wink.test";
const status = (over: Partial<RelayStatus> = {}): RelayStatus => ({
  configured: true,
  enabled: true,
  state: "connected",
  host: HOST,
  relayRttMs: 31,
  certNotAfter: Date.UTC(2027, 0, 5),
  lastError: null,
  nextRetryAt: null,
  problem: null,
  ...over,
});

type Route = (init?: RequestInit) => Awaited<ReturnType<typeof api>>;

function serve(routes: Record<string, Route>) {
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${path}`];
    if (!route) throw new Error(`no route ${init?.method ?? "GET"} ${path}`);
    return route(init);
  });
}

afterEach(() => {
  request.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetRelay();
  document.body.innerHTML = "";
});

async function renderView(props: object = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(PhoneAccessSettings, { request, ...props }))));
  return { host, root };
}

const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const button = (host: Element, name: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name)!;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PhoneAccessSettings", () => {
  it("says not available without a relay this PC can set up, or when the PC refuses the status", async () => {
    serve({ "GET /api/phone-relay/status": () => status({ configured: false, enabled: false, state: "off", host: null }) });
    const off = await renderView();
    expect(off.host.textContent).toContain("Not available on this PC yet. Use Tailscale below.");
    expect(off.host.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
    await act(async () => off.root.unmount());

    request.mockRejectedValue(new Error("not found"));
    const refused = await renderView();
    expect(refused.host.textContent).toContain("Not available on this PC yet. Use Tailscale below.");
    await act(async () => refused.root.unmount());
  });

  it.each([
    ["en", "Paste the setup code"],
    ["ko", "설정 코드"],
  ])("explains the relay code without the removed Phone Link direction in %s", async (locale, copy) => {
    localStorage.setItem("omb-locale", locale);
    serve({ "GET /api/phone-relay/status": () => status({ available: true, configured: false, enabled: false, state: "off", host: null }) });
    const { host, root } = await renderView();
    await act(async () => click(host.querySelector('[role="switch"]')!));
    expect(document.querySelector('[role="dialog"] input')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(copy);
    await act(async () => root.unmount());
  });

  it("keeps a refused setup code in the confirm, and says not available when the relay is forced off", async () => {
    serve({
      "GET /api/phone-relay/status": () => status({ available: true, configured: false, enabled: false, state: "off", host: null }),
      "POST /api/phone-relay/setup": () => {
        throw new Error("the setup code names an invalid relay address");
      },
    });
    const refused = await renderView();
    await act(async () => click(refused.host.querySelector('[role="switch"]')!));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => type(dialog.querySelector<HTMLInputElement>('input[aria-label="Setup Code"]')!, "wks1:localhost:wki1.a.b"));
    await act(async () => click(button(dialog, "Turn On")));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("Could not set up phone access: the setup code names an invalid relay address");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => refused.root.unmount());

    serve({ "GET /api/phone-relay/status": () => status({ available: false, configured: false, enabled: false, state: "off", host: null }) });
    const off = await renderView();
    expect(off.host.textContent).toContain("Not available on this PC yet. Use Tailscale below.");
    await act(async () => off.root.unmount());
  });

  it("shows why the relay client could not start next to a setup code box", async () => {
    const CODE = "wks1:wink.test:wki1.invite.sig";
    const setup = vi.fn(() => status({ state: "reconnecting", host: null, base: "wink.test" }));
    serve({
      "GET /api/phone-relay/status": () =>
        status({ available: true, base: "wink.test", state: "off", host: null, lastError: 'Dynamic require of "crypto" is not supported' }),
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone-relay/setup": setup,
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-error]")?.textContent).toBe('Dynamic require of "crypto" is not supported');
    expect(host.querySelector("[data-phone-access-setup]")).not.toBeNull();
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Setup Code"]')!, CODE));
    await act(async () => click(button(host, "Set Up")));
    expect(setup).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ code: CODE }) });
    expect(host.querySelector("[data-phone-access-setup]")).toBeNull();
    expect(host.textContent).toContain("Connecting to the relay...");
    await act(async () => root.unmount());
  });

  it("names a used, expired or failed setup code in plain words", async () => {
    let answer = "invite-used";
    serve({
      "GET /api/phone-relay/status": () => status({ available: true, configured: false, enabled: false, state: "off", host: null }),
      "POST /api/phone-relay/setup": () => {
        throw new Error(answer);
      },
    });
    const { host, root } = await renderView();
    await act(async () => click(host.querySelector('[role="switch"]')!));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => type(dialog.querySelector<HTMLInputElement>('input[aria-label="Setup Code"]')!, "wks1:wink.test:wki1.invite.sig"));
    for (const [code, text] of [
      ["invite-used", "This setup code was already used. Ask for a new one."],
      ["invite-expired", "This setup code has expired. Ask for a new one."],
      ["enroll-failed", "Could not set up phone access. Try again, or ask for a new setup code."],
    ]) {
      answer = code;
      await act(async () => click(button(dialog, "Turn On")));
      expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(text);
    }
    await act(async () => root.unmount());
  });

  it("clears a refusal as soon as the code is edited, in either setup box", async () => {
    for (const [relay, route] of [
      [status({ available: true, configured: false, enabled: false, state: "off", host: null }), "POST /api/phone-relay/setup"],
      [status({ state: "enrolling", host: null }), "POST /api/phone-relay/enroll"],
    ] as const) {
      serve({
        "GET /api/phone-relay/status": () => relay,
        "GET /api/phone/devices": () => ({ phones: [] }),
        [route]: () => {
          throw new Error("the setup code names an invalid relay address");
        },
      });
      const { host, root } = await renderView();
      if (!relay.configured) await act(async () => click(host.querySelector('[role="switch"]')!));
      const input = document.querySelector("input")!;
      await act(async () => type(input, "wks1:localhost:wki1.a.b"));
      await act(async () => input.form!.requestSubmit());
      expect(document.querySelector('[role="alert"]'), route).not.toBeNull();
      await act(async () => type(input, "wks1:wink.test:wki1.a.b"));
      expect(document.querySelector('[role="alert"]'), route).toBeNull();
      await act(async () => root.unmount());
    }
  });

  it("takes a setup code in the retry box", async () => {
    const CODE = "wks1:wink.test:wki1.invite.sig";
    const enroll = vi.fn(() => status({ base: "wink.test" }));
    serve({
      "GET /api/phone-relay/status": () => status({ state: "enrolling", host: null, base: "wink.test" }),
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone-relay/enroll": enroll,
    });
    const { host, root } = await renderView();
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Setup Code"]')!, CODE));
    await act(async () => click(button(host, "Set Up")));
    expect(enroll).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ invite: CODE }) });
    expect(host.querySelector('input[aria-label="Setup Code"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("asks for a setup code again after a refused one, by the same name", async () => {
    const enroll = vi.fn(() => {
      throw new Error("invite-used");
    });
    serve({
      "GET /api/phone-relay/status": () => status({ state: "enrolling", host: null }),
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone-relay/enroll": enroll,
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-state]")?.textContent).toBe("Paste the setup code you were sent to reach this PC from your phone.");
    expect(host.textContent).not.toMatch(/invite|join/i);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Setup Code"]')!;
    expect(input.placeholder).toBe("Setup code");
    await act(async () => type(input, " wki1.invite.sig "));
    await act(async () => click(button(host, "Set Up")));
    expect(enroll).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ invite: "wki1.invite.sig" }) });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This setup code was already used. Ask for a new one.");
    await act(async () => root.unmount());
  });

  it("shows the relay's own error when no known problem explains it", async () => {
    serve({
      "GET /api/phone-relay/status": () => status({ state: "reconnecting", lastError: "connection to relay closed", nextRetryAt: Date.now() + 9_500 }),
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-state]")?.textContent).toMatch(/^Relay unreachable, retrying in (9|10)s$/);
    expect(host.querySelector("[data-phone-access-error]")?.textContent).toBe("connection to relay closed");
    await act(async () => root.unmount());
  });

  it("counts a retry down from when it was scheduled, however long Settings has been open", async () => {
    vi.useFakeTimers();
    let relay = status();
    serve({ "GET /api/phone-relay/status": () => relay, "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    const state = () => host.querySelector("[data-phone-access-state]")?.textContent;
    try {
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      relay = status({ state: "reconnecting", lastError: "connection to relay closed", nextRetryAt: Date.now() + 9_500 });
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      expect(state()).toBe("Relay unreachable, retrying in 7s");
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(state()).toBe("Relay unreachable, retrying in 6s");
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("warns about a failing certificate renewal while still connected", async () => {
    serve({
      "GET /api/phone-relay/status": () => status({ lastError: "certificate request failed: CA did not answer in time" }),
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-state]")).toBeNull();
    expect(host.querySelector("[data-phone-access-error]")?.textContent).toBe(
      "Certificate renewal failed, will retry: certificate request failed: CA did not answer in time",
    );
    await act(async () => root.unmount());
  });

  it("explains a superseded address and an unknown certificate", async () => {
    serve({
      "GET /api/phone-relay/status": () => status({ state: "rejected", problem: "superseded", lastError: "superseded: this phone address is in use on another computer" }),
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const superseded = await renderView();
    expect(superseded.host.querySelector('[role="alert"]')?.textContent).toBe(
      "This phone address is in use on another computer. Turn phone access off and on here to take it back.",
    );
    expect(button(superseded.host, "Add a Phone")).toBeUndefined();
    await act(async () => superseded.root.unmount());

    serve({
      "GET /api/phone-relay/status": () => status({ problem: "unknown-certificate", lastError: "CT log shows a certificate for x" }),
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const warned = await renderView();
    expect(warned.host.querySelector('[role="alert"]')?.textContent).toMatch(/^Certificate warning: /);
    await act(async () => warned.root.unmount());
  });

  it("lists paired phones and removes one", async () => {
    const remove = vi.fn(() => ({ ok: true }));
    serve({
      "GET /api/phone-relay/status": () => status(),
      "GET /api/phone/devices": () => ({
        phones: [
          { id: "p1", name: "Pixel", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 6) },
          { id: "p2", name: "iPhone", createdAt: Date.UTC(2026, 9, 2), lastSeenAt: Date.UTC(2026, 9, 7) },
        ],
      }),
      "DELETE /api/phone/devices/p1": remove,
    });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("Pixel");
    await act(async () => click(button(host, "Remove Pixel")));
    expect(remove).toHaveBeenCalledWith({ method: "DELETE" });
    expect(host.textContent).not.toContain("Pixel");
    expect(host.textContent).toContain("iPhone");
    expect(JSON.parse(localStorage.getItem("omb-phone-relay")!).phones.map((phone: { name: string }) => phone.name)).toEqual(["iPhone"]);
    await act(async () => root.unmount());
  });

});

describe("This PC", () => {
  const EMAIL = "rocknblock.official@gmail.com";
  const signedIn = () => ({ state: "signed-in", email: EMAIL });
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

  it("switch on asks once, off never asks", async () => {
    let relay = status({ enabled: false, state: "off", host: null });
    const put = vi.fn((init?: RequestInit) => {
      relay = JSON.parse(String(init?.body)).enabled ? status() : status({ enabled: false, state: "off", host: null });
      return relay;
    });
    serve({ "GET /api/phone-relay/status": () => relay, "GET /api/google-account": signedIn, "GET /api/phone/devices": () => ({ phones: [] }), "PUT /api/phone-relay": put });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("Connect from my devices");
    expect(host.textContent).toContain(EMAIL);
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => click(toggle));
    expect(dialog()?.textContent).toContain("Connect to this PC from your devices?");
    expect(dialog()?.textContent).toContain("Full access for your Google account, like SSH.");
    await act(async () => click(button(dialog()!, "Cancel")));
    expect(dialog()).toBeNull();
    expect(put).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => click(toggle));
    await act(async () => click(button(dialog()!, "Turn On")));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith({ method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => click(toggle));
    expect(dialog()).toBeNull();
    expect(put).toHaveBeenLastCalledWith({ method: "PUT", body: JSON.stringify({ enabled: false }) });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => root.unmount());
  });

  it("paints the switch row before the status answers", async () => {
    serve({ "GET /api/phone-relay/status": () => new Promise(() => {}), "GET /api/google-account": signedIn });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-this-pc]")?.textContent).toContain("Connect from my devices");
    expect(host.querySelector('[role="switch"][aria-checked="false"]')).toBeNull();
    expect(host.textContent).not.toContain("Not available on this PC yet.");
    await act(async () => root.unmount());
  });

  it("paints the last status at once after a restart", async () => {
    localStorage.setItem("omb-phone-relay", JSON.stringify({ status: status() }));
    serve({ "GET /api/phone-relay/status": () => new Promise(() => {}), "GET /api/google-account": signedIn, "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("[data-relay-qr]")?.getAttribute("data-url")).toBe(`https://${HOST}/`);
    await act(async () => root.unmount());
  });

  it("paints the last signed-in phones before the PC answers", async () => {
    const pixel = { id: "p1", name: "Pixel", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 6) };
    localStorage.setItem("omb-phone-relay", JSON.stringify({ status: status(), phones: [pixel] }));
    let answer = (_: unknown) => {};
    serve({
      "GET /api/phone-relay/status": () => new Promise(() => {}),
      "GET /api/google-account": signedIn,
      "GET /api/phone/devices": () => new Promise((resolve) => { answer = resolve; }),
    });
    const { host, root } = await renderView();
    const list = () => [...host.querySelectorAll("[data-signed-in] [data-account-row]")];
    expect(list().map((row) => row.querySelector("[data-device-name]")?.textContent)).toEqual(["Pixel"]);
    const first = list()[0];
    await act(async () => answer({ phones: [{ ...pixel, lastSeenAt: Date.UTC(2026, 9, 9) }] }));
    expect(list()[0]).toBe(first);
    expect(list()[0]?.textContent).toContain("Oct 9");
    expect(JSON.parse(localStorage.getItem("omb-phone-relay")!).phones[0].lastSeenAt).toBe(Date.UTC(2026, 9, 9));
    await act(async () => root.unmount());
  });

  it("holds a quiet row, not None, until the phones first answer", async () => {
    localStorage.setItem("omb-phone-relay", JSON.stringify({ status: status() }));
    serve({ "GET /api/phone-relay/status": () => new Promise(() => {}), "GET /api/google-account": signedIn, "GET /api/phone/devices": () => new Promise(() => {}) });
    const { host, root } = await renderView();
    const list = [...host.querySelectorAll("[data-signed-in] [data-account-row]")];
    expect(list).toHaveLength(1);
    expect(list[0]!.textContent!.trim()).toBe("");
    expect(host.querySelector("[data-signed-in] .animate-pulse")).toBeNull();
    await act(async () => root.unmount());
  });

  it("warms the signed-in phones with the relay state", async () => {
    const pixel = { id: "p1", name: "Pixel", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 6) };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("google") ? signedIn() : url.includes("phone/devices") ? { phones: [pixel] } : status())));
    await warmRelay();
    serve({ "GET /api/phone-relay/status": () => new Promise(() => {}), "GET /api/google-account": () => new Promise(() => {}), "GET /api/phone/devices": () => new Promise(() => {}) });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-signed-in]")?.textContent).toContain("Pixel");
    await act(async () => root.unmount());
  });

  it("paints the warmed state on the first open with nothing saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("google") ? signedIn() : status()))));
    await warmRelay();
    serve({ "GET /api/phone-relay/status": () => new Promise(() => {}), "GET /api/google-account": () => new Promise(() => {}), "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain(EMAIL);
    await act(async () => root.unmount());
  });

  it("skips the warm-up off this PC", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { hostname: "pc.fixture.ts.net" });
    await warmRelay();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("not available offers tailscale", async () => {
    serve({ "GET /api/phone-relay/status": () => status({ available: false, configured: false, enabled: false, state: "off", host: null }), "GET /api/google-account": signedIn });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("Not available on this PC yet. Use Tailscale below.");
    expect(host.textContent).not.toContain("for this account");
    await act(async () => root.unmount());
  });

  it.each([
    ["abcdefghijklmnop.wink.edwardyi.dev", "wink.edwardyi.dev", "https://wink.edwardyi.dev/"],
    [HOST, "abcd….wink.test", `https://${HOST}/`],
  ])("shows and copies the front door when it can open %s", async (host, shown, copied) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    serve({ "GET /api/phone-relay/status": () => status({ host }), "GET /api/google-account": signedIn, "GET /api/phone/devices": () => ({ phones: [] }) });
    const view = await renderView();
    expect(view.host.textContent).toContain("Open on any device");
    expect(view.host.querySelector("[data-relay-link]")?.textContent).toBe(shown);
    expect(view.host.textContent).toContain("Paste it in any browser or scan with a phone. Continue with Google.");
    await act(async () => click(button(view.host, "Copy Link")));
    expect(writeText).toHaveBeenCalledWith(copied);
    await act(async () => view.root.unmount());
  });

  it("signed out shows Sign In in the switch's place", async () => {
    const signIn = vi.fn(async () => ({ ok: true as const, email: EMAIL }));
    vi.stubGlobal("ogb", { googleAccount: { signIn, cancel: vi.fn(), signOut: vi.fn() } });
    serve({ "GET /api/phone-relay/status": () => status({ enabled: false, state: "off", host: null }), "GET /api/google-account": () => ({ state: "signed-out" }) });
    const { host, root } = await renderView();
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(host.textContent).toContain("Sign in with Google to turn this on.");
    await act(async () => click(button(host, "Sign In")));
    expect(signIn).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps the switch off for an account the relay does not take", async () => {
    serve({ "GET /api/phone-relay/status": () => status({ available: false, configured: false, enabled: false, state: "off", host: null }), "GET /api/google-account": signedIn });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("Not available on this PC yet. Use Tailscale below.");
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => root.unmount());
  });

  it("no ticket: the confirm asks for the setup code", async () => {
    const setup = vi.fn(() => status());
    serve({
      "GET /api/phone-relay/status": () => status({ available: true, configured: false, enabled: false, state: "off", host: null }),
      "GET /api/google-account": signedIn,
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone-relay/setup": setup,
    });
    const { host, root } = await renderView();
    await act(async () => click(host.querySelector('[role="switch"]')!));
    const input = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Setup Code"]')!;
    expect(button(dialog()!, "Turn On").disabled).toBe(true);
    await act(async () => type(input, " wks1.code "));
    await act(async () => click(button(dialog()!, "Turn On")));
    expect(setup).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ code: "wks1.code" }) });
    expect(dialog()).toBeNull();
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    await act(async () => root.unmount());
  });

  it("keeps the setup code field when setup fails after the PC saved the base", async () => {
    vi.useFakeTimers();
    let relay = status({ available: true, configured: false, enabled: false, state: "off", host: null });
    const setup = vi.fn(() => {
      relay = status({ state: "reconnecting", host: null });
      throw new Error("enrollment failed");
    });
    serve({ "GET /api/phone-relay/status": () => relay, "GET /api/google-account": signedIn, "GET /api/phone/devices": () => ({ phones: [] }), "POST /api/phone-relay/setup": setup });
    const { host, root } = await renderView();
    await act(async () => click(host.querySelector('[role="switch"]')!));
    await act(async () => type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Setup Code"]')!, "wks1.code"));
    await act(async () => click(button(dialog()!, "Turn On")));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(dialog()?.querySelector('input[aria-label="Setup Code"]')).not.toBeNull();
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => click(button(dialog()!, "Turn On")));
    expect(setup).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    vi.useRealTimers();
  });

  it("keeps the switch when signed out without the desktop sign-in", async () => {
    serve({ "GET /api/phone-relay/status": () => status({ enabled: false, state: "off", host: null }), "GET /api/google-account": () => ({ state: "signed-out" }) });
    const { host, root } = await renderView();
    expect(host.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("a failed poll keeps the last status, and the list follows new sign-ins", async () => {
    vi.useFakeTimers();
    let up = true;
    let phones: { id: string; name: string; createdAt: number; lastSeenAt: number }[] = [];
    serve({
      "GET /api/phone-relay/status": () => {
        if (!up) throw new Error("timeout");
        return status();
      },
      "GET /api/google-account": signedIn,
      "GET /api/phone/devices": () => ({ phones }),
    });
    const { host, root } = await renderView();
    up = false;
    phones = [{ id: "p1", name: "iPhone", createdAt: Date.UTC(2026, 10, 8), lastSeenAt: Date.UTC(2026, 10, 10) }];
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(host.textContent).not.toContain("Not available on this PC yet.");
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("[data-signed-in]")?.textContent).toContain("iPhone");
    await act(async () => root.unmount());
    vi.useRealTimers();
  });

  it("no check on the switch row", async () => {
    serve({ "GET /api/phone-relay/status": () => status(), "GET /api/google-account": signedIn, "GET /api/phone/devices": () => ({ phones: [{ id: "p1", name: "iPhone", createdAt: Date.UTC(2026, 10, 8), lastSeenAt: Date.UTC(2026, 10, 10) }] }) });
    const { host, root } = await renderView();
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector(".animate-pop-in")).toBeNull();
    await act(async () => root.unmount());
  });

  it("your pcs above signed in", async () => {
    serve({ "GET /api/phone-relay/status": () => status(), "GET /api/google-account": signedIn, "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView({ pcs: createElement("section", { "data-your-pcs": "" }) });
    expect([...host.querySelectorAll("section")].map((section) => section.getAttributeNames().find((name) => name.startsWith("data-")))).toEqual(["data-this-pc", "data-your-pcs", "data-signed-in"]);
    await act(async () => root.unmount());
  });

  it("shows this PC's address as a QR while on, and the devices signed in to it", async () => {
    serve({
      "GET /api/phone-relay/status": () => status(),
      "GET /api/google-account": signedIn,
      "GET /api/phone/devices": () => ({ phones: [{ id: "p1", name: "iPhone", createdAt: Date.UTC(2026, 10, 8), lastSeenAt: Date.UTC(2026, 10, 10) }] }),
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-relay-qr]")?.getAttribute("data-url")).toBe(`https://${HOST}/`);
    expect(host.textContent).toContain("Open on any device");
    expect(button(host, "Copy Link")).toBeDefined();
    expect(host.textContent).toContain("Signed in to this PC");
    expect(button(host, "Remove iPhone")).toBeDefined();
    await act(async () => root.unmount());
  });

  it.each([
    ["en", ["This PC", "Connect from my devices", "Open on any device", "Paste it in any browser or scan with a phone. Continue with Google.", "Signed in to this PC"]],
    ["ko", ["이 PC", "내 기기에서 연결", "다른 기기에서 열기", "아무 브라우저에 붙여넣거나 휴대폰으로 스캔하세요. Google로 계속하세요.", "이 PC에 로그인한 기기"]],
  ])("labels the page in %s", async (locale, labels) => {
    localStorage.setItem("omb-locale", locale);
    serve({ "GET /api/phone-relay/status": () => status(), "GET /api/google-account": signedIn, "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    for (const label of labels) expect(host.textContent).toContain(label);
    await act(async () => root.unmount());
  });
});
