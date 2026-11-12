// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HTML = readFileSync(join(ROOT, "site/signin/index.html"), "utf8");
const SCRIPT = readFileSync(join(ROOT, "site/signin/signin.js"), "utf8");
const CSS = readFileSync(join(ROOT, "site/signin/signin.css"), "utf8");
const MARKUP = HTML.slice(HTML.indexOf("<main>"), HTML.indexOf("</main>") + "</main>".length);

const CLIENT = "test-client.apps.googleusercontent.com";
const BASE = "wink.edwardyi.dev";
const LABEL_A = "aaaaaaaaaaaaaaaa";
const LABEL_B = "bbbbbbbbbbbbbbbb";
const M = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NONCE = "B63Cih-MfFXEza9EFx1F5hxPxyw7HsmG35Odfsi7nG0";
const DIR_TOKEN = "dir-token";
const PC_TOKEN = "pc-token";
const EMPTY = "Sign in with Google in Wink on your PC first: Settings, Sync.";
const OFFLINE = "Could not reach your PC. Check your connection and try again.";
const GOOGLE_DOWN = "Could not load Google sign-in. Check your connection and try again.";
const GIS_BOOM = "gis-initialize-blew-up";
const LAST_PC = "wink-signin-pc";

interface Pc {
  label: string;
  name: string;
}

interface GisResponse {
  credential: string;
}

interface GisInit {
  client_id: string;
  callback: (response: GisResponse) => void;
  nonce: string;
  auto_select: boolean;
  ux_mode: string;
}

interface GisMoment {
  isNotDisplayed: () => boolean;
  isSkippedMoment: () => boolean;
  isDismissedMoment: () => boolean;
  getDismissedReason: () => string;
}

interface FetchCall {
  url: string;
  method: string;
  authorization: string;
  body: string;
}

const inits: GisInit[] = [];
const prompts: Array<(moment: GisMoment) => void> = [];
const calls: FetchCall[] = [];
const probes: string[] = [];
const buttons: Array<{ theme: string; text: string; shape: string }> = [];
let renders = 0;

function installGoogle(gisError?: string): void {
  inits.length = 0;
  prompts.length = 0;
  renders = 0;
  buttons.length = 0;
  vi.stubGlobal("google", {
    accounts: {
      id: {
        initialize(options: GisInit): void {
          if (gisError) throw new Error(gisError);
          inits.push(options);
        },
        renderButton(slot: HTMLElement, options: { theme: string; text: string; shape: string }): void {
          renders += 1;
          buttons.push(options);
          const frame = document.createElement("iframe");
          frame.style.height = "0px";
          slot.append(frame);
        },
        prompt(listener: (moment: GisMoment) => void): void {
          prompts.push(listener);
        },
        cancel(): void {},
      },
    },
  });
}

function installFetch(body: Pc[] | "fail"): void {
  calls.length = 0;
  vi.stubGlobal("fetch", (input: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({
      url: input,
      method: init.method ?? "",
      authorization: headers.get("authorization") ?? "",
      body: init.body == null ? "" : String(init.body),
    });
    if (body === "fail") return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

function open(url: string, body: Pc[] | "fail", gisError?: string, probe = "up"): void {
  document.body.innerHTML = MARKUP;
  history.replaceState(null, "", url);
  vi.stubGlobal("WINK_SIGNIN", { clientId: CLIENT, base: BASE });
  installGoogle(gisError);
  installFetch(body);
  probes.length = 0;
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      if (!value) return;
      probes.push(value);
      queueMicrotask(() => {
        if (probe === "up") this.onload?.();
        else if (probe === "down") this.onerror?.();
      });
    }
  });
  runInThisContext(SCRIPT);
}

function hiddenMoment(): GisMoment {
  return {
    isNotDisplayed: () => true,
    isSkippedMoment: () => false,
    isDismissedMoment: () => false,
    getDismissedReason: () => "",
  };
}

const pair = (label: string, suffix: string) => `https://${label}.${BASE}/pair${suffix}`;

function paintGoogle(): void {
  const frame = document.querySelector<HTMLIFrameElement>("#google iframe")!;
  Object.defineProperty(frame, "offsetHeight", { value: 44 });
  frame.style.height = "44px";
}

const googleReady = () => document.getElementById("google")!.classList.contains("ready");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

describe("phone sign-in page", () => {
  it.each(["light", "dark"])("shows the Wink mark in %s mode", (scheme) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: scheme === "dark" && query === "(prefers-color-scheme: dark)" }));
    open("/signin", []);
    const logo = document.querySelector<HTMLImageElement>(".logo");
    expect(logo).not.toBeNull();
    expect(logo?.getAttribute("src")).toBe("/app-icon.svg");
    expect(logo?.alt).toBe("Wink");
    expect(logo?.width).toBe(48);
    expect(logo?.height).toBe(48);
    const workflow = readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8");
    expect(workflow).toContain('copyFileSync("public/app-icon.svg", "site/app-icon.svg")');
  });

  it.each([["light", "outline"], ["dark", "filled_black"]])("renders Google's button for %s mode", (scheme, theme) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: scheme === "dark" && query === "(prefers-color-scheme: dark)" }));
    open("/signin", []);
    expect(buttons).toEqual([expect.objectContaining({ theme, text: "signin_with", shape: "rectangular" })]);
    expect(inits).toHaveLength(1);
    expect(prompts).toHaveLength(0);
  });

  it.each([["light", "wink-day"], ["dark", "precision"]])("uses Wink's %s colors for the OS preference", (scheme, skin) => {
    const styles = readFileSync(join(ROOT, "src/styles.css"), "utf8");
    const tokens = styles.match(new RegExp(`\\[data-skin="${skin}"\\] \\{([^}]+)\\}`))![1]!;
    const match = scheme === "light" ? CSS.match(/:root \{([^}]+)\}/) : CSS.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]+)\}/);
    expect(match).not.toBeNull();
    const page = match![1]!;
    expect(page).toContain(`color-scheme: ${scheme};`);
    for (const name of ["app", "inset", "hairline", "ink", "ink-secondary", "accent", "danger"]) {
      const color = tokens.match(new RegExp(`--color-${name}: ([^;]+);`))![1]!;
      expect(page).toContain(`--${name}: ${color};`);
    }
    const app = tokens.match(/--color-app: ([^;]+);/)![1]!;
    expect(HTML).toContain(`<meta name="theme-color" content="${app}" media="(prefers-color-scheme: ${scheme})" />`);
  });

  it("ships a strict page with no inline script", () => {
    expect(HTML).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(HTML).toContain("connect-src https://relay.wink.edwardyi.dev");
    expect(HTML).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(HTML.match(/script-src ([^;]+);/)![1]).not.toContain("unsafe-inline");
    const workflow = readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8");
    expect(workflow).toContain("branches: [review-base]");
    expect(workflow).toContain('"site/**"');
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("WINK_GOOGLE_WEB_CLIENT_ID");
    expect(workflow).toContain("WINK_RELAY_BASE");
    expect(workflow).toContain('requested || "wink.edwardyi.dev"');
  });

  it("allows Google and relay requests, with PC images limited to the relay base", () => {
    const policy =
      "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' https://*.wink.edwardyi.dev; connect-src https://relay.wink.edwardyi.dev https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
    expect(HTML).toContain(policy);
    const relay = "https://relay.example.dev";
    const shipped = HTML.replaceAll("https://relay.wink.edwardyi.dev", relay).replaceAll("https://*.wink.edwardyi.dev", "https://*.example.dev");
    expect(shipped).toContain(policy.replaceAll("https://relay.wink.edwardyi.dev", relay).replaceAll("https://*.wink.edwardyi.dev", "https://*.example.dev"));
    expect(shipped).not.toContain("https://relay.wink.edwardyi.dev");
  });

  it("sends its origin to Google's button frame", () => {
    expect(HTML).toContain('<meta name="referrer" content="strict-origin" />');
    expect(HTML).not.toContain("no-referrer");
  });

  it("links to the privacy policy", () => {
    expect(HTML).toContain("Reach Wink on your PC from this browser.");
    expect(HTML).toContain('<a class="privacy" href="/privacy">Privacy</a>');
  });

  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "this phone"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36", "this phone"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", "this browser"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", "this browser"],
    ["Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", "this browser"],
  ])("words the subtitle for the device (%s)", (agent, device) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    open("/signin", []);
    expect(document.getElementById("subtitle")?.textContent).toBe(`Reach Wink on your PC from ${device}.`);
  });

  it.each(["/signin", "/?pick=1"])("keeps Google's button hidden until its frame draws, then fades it in once (%s)", async (url) => {
    open(url, []);
    const slot = document.getElementById("google")!;
    expect(slot.querySelector("iframe")).not.toBeNull();
    expect(googleReady()).toBe(false);
    paintGoogle();
    await vi.waitFor(() => expect(googleReady()).toBe(true));
    expect(renders).toBe(1);
    expect(CSS).toMatch(/#google \{[^}]*min-height: 40px;[^}]*opacity: 0;[^}]*transition: opacity 150ms;/);
    expect(CSS).toMatch(/#google\.ready \{\s*opacity: 1;/);
  });

  it("shows Google's button after a short wait when its frame never draws", async () => {
    vi.useFakeTimers();
    open("/signin", []);
    await vi.advanceTimersByTimeAsync(1499);
    expect(googleReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(googleReady()).toBe(true);
  });

  it("presses PC buttons in and shows which PC is opening", async () => {
    expect(CSS).toMatch(/\.list button \{[^}]*cursor: pointer;[^}]*transition: filter 150ms, transform 150ms;/);
    expect(CSS).toMatch(/\.list button:hover:not\(:disabled\) \{/);
    expect(CSS).toMatch(/\.list button:active:not\(:disabled\) \{\s*transform: scale\(0\.99\);/);
    expect(CSS).toMatch(/\.list button:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }]);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    const [ada, zed] = [...document.querySelectorAll<HTMLButtonElement>("#list button")];
    ada!.click();
    expect(ada!.textContent).toBe("Opening Ada…");
    expect(ada!.querySelector(".spinner")).not.toBeNull();
    expect(ada!.getAttribute("aria-busy")).toBe("true");
    expect([ada!.disabled, zed!.disabled]).toEqual([true, true]);
    expect(location.href).toBe(pair(LABEL_A, "?g=1"));
  });

  it("opens only the first PC clicked", async () => {
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }]);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    const [ada, zed] = [...document.querySelectorAll<HTMLButtonElement>("#list button")];
    ada!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    ada!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    zed!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(location.href).toBe(pair(LABEL_A, "?g=1"));
    expect(localStorage.getItem(LAST_PC)).toBe(LABEL_A);
    expect(zed!.textContent).toBe("Zed");
  });

  it("frees the PC list when Back restores the page", async () => {
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }]);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    document.querySelector<HTMLButtonElement>("#list button")!.click();
    dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#list button")];
    expect(buttons.map((button) => [button.textContent, button.disabled])).toEqual([["Ada", false], ["Zed", false]]);
  });

  it("sends a cold start with one PC straight to that PC", async () => {
    open("/signin", [{ label: LABEL_A, name: "Home" }]);
    expect(prompts).toHaveLength(0);
    expect(renders).toBe(1);
    expect(inits[0]?.auto_select).toBe(false);
    expect(inits[0]?.client_id).toBe(CLIENT);
    expect(inits[0]?.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(calls).toEqual([
      {
        url: `https://relay.${BASE}/v1/pcs`,
        method: "GET",
        authorization: `Bearer ${DIR_TOKEN}`,
        body: "",
      },
    ]);
    expect(location.href).not.toContain(DIR_TOKEN);
    expect(localStorage.getItem(LAST_PC)).toBe(LABEL_A);
  });

  it("lists several PCs by name and remembers the pick", async () => {
    open("/signin", [
      { label: LABEL_B, name: "Zed" },
      { label: LABEL_A, name: "Ada" },
    ]);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    expect(location.href).not.toContain("/pair");
    const buttons = [...document.querySelectorAll("#list button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Ada", "Zed"]);
    buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(location.href).toBe(pair(LABEL_A, "?g=1"));
    expect(localStorage.getItem(LAST_PC)).toBe(LABEL_A);
  });

  it("returns to the remembered PC without asking Google or loading the directory", async () => {
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [
      { label: LABEL_A, name: "Ada" },
      { label: LABEL_B, name: "Zed" },
    ]);
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1")));
    expect(inits).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(probes).toHaveLength(1);
    expect(new URL(probes[0]!).pathname).toBe("/app-icon.svg");
    expect(new URL(probes[0]!).searchParams.has("probe")).toBe(true);
    expect(document.querySelectorAll("#list button")).toHaveLength(0);
  });

  it.each(["down", "timeout"])("shows the PC list when the remembered PC probe fails (%s)", async (probe) => {
    vi.useFakeTimers();
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }], undefined, probe);
    await vi.advanceTimersByTimeAsync(1999);
    if (probe === "timeout") expect(inits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(inits).toHaveLength(1);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    expect(location.href).not.toContain("/pair");
    expect(document.querySelector<HTMLAnchorElement>("#pick")?.getAttribute("href")).toBe("/?pick=1");
  });

  it.each([1, 2])("always lists %s PCs with pick=1 despite a remembered PC", async (count) => {
    localStorage.setItem(LAST_PC, LABEL_B);
    const pcs = [{ label: LABEL_B, name: "Zed" }, { label: LABEL_A, name: "Ada" }].slice(0, count);
    open("/?pick=1", pcs);
    expect(inits).toHaveLength(1);
    expect(probes).toHaveLength(0);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(count));
    expect(location.href).not.toContain("/pair");
  });

  it.each(["", "short", "aaaaaaaaaaaaaaaa.evil", "AAAAAAAAAAAAAAAA"])("discovers PCs when the remembered label is invalid (%s)", async (label) => {
    localStorage.setItem(LAST_PC, label);
    open("/signin", [
      { label: LABEL_A, name: "Ada" },
      { label: LABEL_B, name: "Zed" },
    ]);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    expect(location.href).not.toContain("/pair");
  });

  it("asks Google once on the return leg and forwards that token only to a listed label", async () => {
    const expected = createHash("sha256").update(`wink-gpair/1\0${LABEL_B}\0${M}`).digest("base64url");
    expect(expected).toBe(NONCE);
    open(`/signin?pc=${LABEL_B}&m=${M}`, [
      { label: LABEL_A, name: "Ada" },
      { label: LABEL_B, name: "Zed" },
    ]);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    expect(inits[0]?.nonce).toBe(NONCE);
    expect(inits[0]?.auto_select).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(renders).toBe(0);
    inits[0]?.callback({ credential: PC_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, `#g=${PC_TOKEN}`)));
    expect(inits).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${PC_TOKEN}`);
  });

  it("shows the button when auto_select does not fire", async () => {
    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    prompts[0]?.(hiddenMoment());
    expect(renders).toBe(1);
    inits[0]?.callback({ credential: PC_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, `#g=${PC_TOKEN}`)));
    expect(prompts).toHaveLength(1);
    expect(renders).toBe(1);
  });

  it("does not forward a return leg to a PC that is not listed", async () => {
    open(`/signin?pc=${LABEL_A}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    inits[0]?.callback({ credential: PC_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe("That PC is not signed in to this Google account."));
    expect(document.getElementById("status")?.className).toBe("status error");
    expect(inits).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(location.href).not.toContain("/pair");
    expect(calls).toHaveLength(1);
  });

  it.each(["short", "AAAAAAAAAAAAAAAA", "aaaaaaaaaaaaaaa0", "aaaaaaaaaaaaaaaa.evil"])("refuses a bad label (%s)", (pc) => {
    open(`/signin?pc=${encodeURIComponent(pc)}&m=${M}`, [{ label: LABEL_A, name: "Home" }]);
    expect(inits).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(document.getElementById("status")?.textContent).toBe("That PC link is not valid.");
    expect(location.href).not.toContain("/pair");
  });

  it("drops a directory label that is not a relay label", async () => {
    open("/signin", [{ label: "not-a-label", name: "Nope" }]);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(EMPTY));
    expect(location.href).not.toContain("/pair");
  });

  it("shows the empty-list copy", async () => {
    open("/signin", []);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(EMPTY));
    expect(location.href).not.toContain("/pair");
  });

  it("shows the offline copy when the relay cannot be reached", async () => {
    open("/signin", "fail");
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(OFFLINE));
    expect(location.href).not.toContain("/pair");
  });

  it("shows the generic error when a cold start is rejected", async () => {
    open("/signin", [], GIS_BOOM);
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(GOOGLE_DOWN));
    expect(document.getElementById("status")?.className).toBe("status error");
    expect(document.body.textContent).not.toContain(GIS_BOOM);
  });

  it("shows the generic error when a return leg is rejected", async () => {
    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }], GIS_BOOM);
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(GOOGLE_DOWN));
    expect(document.getElementById("status")?.className).toBe("status error");
    expect(document.body.textContent).not.toContain(GIS_BOOM);
  });
});
