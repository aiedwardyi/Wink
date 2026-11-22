// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shortCodeChars } from "../../src/components/CodeBoxes";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HTML = readFileSync(join(ROOT, "site/signin/index.html"), "utf8");
const SCRIPT = readFileSync(join(ROOT, "site/signin/signin.js"), "utf8");
const CSS = readFileSync(join(ROOT, "site/signin/signin.css"), "utf8");
const MARKUP = HTML.slice(HTML.indexOf("<main>"), HTML.indexOf("</main>") + "</main>".length);

const CLIENT = "test-client.apps.googleusercontent.com";
const BASE = "app.getwink.dev";
const LABEL_A = "aaaaaaaaaaaaaaaa";
const LABEL_B = "bbbbbbbbbbbbbbbb";
const M = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NONCE = "B63Cih-MfFXEza9EFx1F5hxPxyw7HsmG35Odfsi7nG0";
const DIR_TOKEN = "dir-token";
const PC_TOKEN = "pc-token";
const EMPTY = "Sign in with Google in Wink on your PC first: Settings, Devices.";
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
  login_hint?: string;
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
  sessionStorage.clear();
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
    expect(buttons).toEqual([expect.objectContaining({ theme, text: "signin_with", shape: "pill" })]);
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
    expect(HTML).toContain("connect-src https://relay.app.getwink.dev");
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
    expect(workflow).toContain('requested || "app.getwink.dev"');
    expect(workflow).toContain('writeFileSync("site/CNAME", `${base}\\n`);');
  });

  it.each(["site/signin/index.html", "site/privacy/index.html"])("keeps %s's meta policy to directives a meta tag honors", (page) => {
    // a browser ignores these from a meta tag and logs a console error on every load; they need a response header
    const policy = readFileSync(join(ROOT, page), "utf8").match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)![1];
    expect(policy).not.toMatch(/(frame-ancestors|report-uri|sandbox)/);
  });

  it("allows Google and relay requests, with PC images and code checks limited to the relay base", () => {
    const policy =
      "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' https://*.app.getwink.dev; connect-src https://relay.app.getwink.dev https://*.app.getwink.dev https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'none'; form-action 'none'; object-src 'none'";
    expect(HTML).toContain(policy);
    const relay = "https://relay.example.dev";
    const shipped = HTML.replaceAll("https://relay.app.getwink.dev", relay).replaceAll("https://*.app.getwink.dev", "https://*.example.dev");
    expect(shipped).toContain(policy.replaceAll("https://relay.app.getwink.dev", relay).replaceAll("https://*.app.getwink.dev", "https://*.example.dev"));
    expect(shipped).not.toContain("https://relay.app.getwink.dev");
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
    if (url.includes("pick")) prompts[0]!(hiddenMoment());
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
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1&n=Ada")));
  });

  it("rings only the last-used PC, with no glow animation under reduced motion", async () => {
    expect(CSS).toMatch(/\.list button \{[^}]*border-radius: 999px;/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none;/);
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }, { label: "cccccccccccccccc", name: "Mid" }]);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(3));
    const rows = [...document.querySelectorAll("#list button")].map((button) => [button.textContent, button.classList.contains("last")]);
    expect(rows).toEqual([["Ada", false], ["Mid", false], ["Zed", true]]);
  });

  it("draws the last-used arcs in Wink's blue accent, not pink, in light and dark", () => {
    const precision = readFileSync(join(ROOT, "src/styles.css"), "utf8").match(/\[data-skin="precision"\] \{([^}]+)\}/)![1]!;
    const accent = precision.match(/--color-accent: ([^;]+);/)![1]!;
    expect(CSS.match(/:root \{([^}]+)\}/)![1]).toContain(`--edge: ${accent};`);
    expect([...CSS.matchAll(/--edge(-glow)?: ([^;]+);/g)].map((each) => each[2]!.slice(0, 7))).toEqual([accent, accent, accent]);
    expect(CSS.toLowerCase()).not.toContain("#ff4d9d");
    expect(CSS).toMatch(/\.last::after \{[^}]*border-color: var\(--edge\);/);
  });

  it.each([[LABEL_B, true], ["", false], ["short", false]])("rings Google's button only for a remembered PC (%s)", (label, ringed) => {
    if (label) localStorage.setItem(LAST_PC, label);
    open("/?pick=1", []);
    prompts[0]!(hiddenMoment());
    expect(document.getElementById("google")!.classList.contains("last")).toBe(ringed);
  });

  it("opens only the first PC clicked", async () => {
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }]);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    const [ada, zed] = [...document.querySelectorAll<HTMLButtonElement>("#list button")];
    ada!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    ada!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    zed!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1&n=Ada")));
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
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1&n=Home")));
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
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1&n=Ada")));
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
    expect(document.getElementById("pick")?.hidden).toBe(true);
  });

  it("titles the PC list Choose a PC with no sign-in wording", async () => {
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }]);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    expect(document.querySelector("h1")?.textContent).toBe("Choose a PC");
    expect(document.querySelector("main")?.textContent).not.toMatch(/sign in/i);
    expect(document.querySelectorAll("main a:not([hidden])")).toHaveLength(1);
  });

  it.each(["/signin", "/?pick=1"])("offers no link back to itself while signed out (%s)", (url) => {
    open(url, [{ label: LABEL_A, name: "Ada" }]);
    if (url.includes("pick")) prompts[0]!(hiddenMoment());
    expect(document.querySelector("h1")?.textContent).toBe("Sign in");
    expect(document.getElementById("pick")?.hidden).toBe(true);
  });

  it.each([LABEL_A, "short"])("offers Choose another PC from a PC link that fails (%s)", async (label) => {
    open(`/signin?pc=${label}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    if (label === LABEL_A) {
      await vi.waitFor(() => expect(inits).toHaveLength(1));
      inits[0]!.callback({ credential: PC_TOKEN });
    }
    await vi.waitFor(() => expect(document.getElementById("status")?.className).toBe("status error"));
    const pick = document.querySelector<HTMLAnchorElement>("#pick")!;
    expect(pick.hidden).toBe(false);
    expect(pick.getAttribute("href")).toBe("/?pick=1");
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
    expect(inits[0]?.login_hint).toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(renders).toBe(0);
    inits[0]?.callback({ credential: PC_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, `#g=${PC_TOKEN}`)));
    expect(inits).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${PC_TOKEN}`);
  });

  it("asks Google for the cold start's account on the return leg, so a first sign-in picks the account once", async () => {
    const idToken = ["e30", Buffer.from(JSON.stringify({ sub: "1234567890" })).toString("base64url"), "sig"].join(".");
    open("/signin", [
      { label: LABEL_A, name: "Ada" },
      { label: LABEL_B, name: "Zed" },
    ]);
    expect(inits[0]?.login_hint).toBeUndefined();
    inits[0]!.callback({ credential: idToken });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    document.querySelector<HTMLButtonElement>("#list button:last-child")!.click();
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1&n=Zed")));
    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    expect(inits[0]).toMatchObject({ nonce: NONCE, auto_select: true, login_hint: "1234567890" });
  });

  it("refuses a return leg token for another account than the cold start picked, and asks by name only once for that PC", async () => {
    const token = (sub: string) => ["e30", Buffer.from(JSON.stringify({ sub })).toString("base64url"), "sig"].join(".");
    const twoPcs = [
      { label: LABEL_A, name: "Ada" },
      { label: LABEL_B, name: "Zed" },
    ];
    open("/signin", twoPcs);
    inits[0]!.callback({ credential: token("1234567890") });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    document.querySelector<HTMLButtonElement>("#list button:last-child")!.click();
    await vi.waitFor(() => expect(location.href).toContain("/pair"));
    open(`/signin?pc=${LABEL_A}&m=${M}`, [{ label: LABEL_A, name: "Ada" }]);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    expect(inits[0]?.login_hint).toBeUndefined();

    open("/signin?pick=1", twoPcs);
    inits[0]!.callback({ credential: token("1234567890") });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    document.querySelector<HTMLButtonElement>("#list button:last-child")!.click();
    await vi.waitFor(() => expect(location.href).toContain("/pair"));
    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    expect(inits[0]?.login_hint).toBe("1234567890");
    inits[0]!.callback({ credential: token("999") });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe("That PC is not signed in to this Google account."));
    expect(location.href).not.toContain("#g=");

    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    expect(inits[0]?.login_hint).toBeUndefined();
  });

  it("titles the return leg Opening <PC name>… with the spinner and hands the name to the PC", async () => {
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }]);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    document.querySelector<HTMLButtonElement>("#list button:last-child")!.click();
    await vi.waitFor(() => expect(location.href).toContain("/pair"));
    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    const title = document.querySelector("h1")!;
    expect(title.textContent).toBe("Opening Zed…");
    expect(title.querySelector(".spinner")).not.toBeNull();
    expect(document.querySelector("main")?.textContent).not.toMatch(/sign in|pair/i);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    inits[0]!.callback({ credential: PC_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, `#g=${PC_TOKEN}&n=Zed`)));
    expect(title.textContent).toBe("Opening Zed…");
  });

  it("says Opening Wink… on a return leg with no PC name, and Sign in once Google needs a click", async () => {
    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    expect(document.querySelector("h1")?.textContent).toBe("Opening Wink…");
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    prompts[0]!(hiddenMoment());
    expect(document.querySelector("h1")?.textContent).toBe("Sign in");
    expect(document.querySelector("h1 .spinner")).toBeNull();
  });

  it.each<[string, Pc[] | "fail"]>([[LABEL_A, [{ label: LABEL_B, name: "Zed" }]], [LABEL_B, "fail"]])("goes back to Sign in when the return leg fails (%s)", async (label, body) => {
    open(`/signin?pc=${label}&m=${M}`, body);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    inits[0]!.callback({ credential: PC_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.className).toBe("status error"));
    expect(document.querySelector("h1")?.textContent).toBe("Sign in");
  });

  it("asks Google quietly first when coming from a PC, and draws the button only if Google shows nothing", async () => {
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }]);
    expect(inits[0]?.auto_select).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(renders).toBe(0);
    expect(document.querySelector("main")?.textContent).not.toMatch(/sign in/i);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    expect(renders).toBe(0);
    open("/?pick=1", []);
    prompts[0]!(hiddenMoment());
    expect(renders).toBe(1);
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

  it("loads the empty list again when the person comes back, and opens the PC that turned on", async () => {
    open("/signin", []);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(EMPTY));
    installFetch([{ label: LABEL_A, name: "Home" }]);
    dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1&n=Home")));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.authorization === `Bearer ${DIR_TOKEN}`)).toBe(true);
  });

  it("loads the list on a later return after one failed load", async () => {
    open("/signin", []);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(EMPTY));
    installFetch("fail");
    dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    installFetch([{ label: LABEL_A, name: "Home" }]);
    dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1&n=Home")));
  });

  it("keeps the list and says a PC is offline instead of sending the browser to its dead host", async () => {
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }], undefined, "down");
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    document.querySelector<HTMLButtonElement>("#list button")!.click();
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe("Ada is offline."));
    expect(document.getElementById("status")?.className).toBe("status error");
    expect(location.href).not.toContain("/pair");
    expect(new URL(probes[0]!).hostname).toBe(`${LABEL_A}.${BASE}`);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#list button")];
    expect(buttons.map((button) => [button.textContent, button.disabled])).toEqual([["Ada", false], ["Zed", false]]);
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

describe("entering a PC's code", () => {
  const BAD_CODE = "That code did not work. Check it in Wink on your PC: Settings, Devices.";
  const LOOKUP = `https://relay.${BASE}/v1/room-codes/ABCDEF`;
  const CHECK = `https://${LABEL_A}.${BASE}/api/phone/open-code?c=ABCDEF`;
  type Answer = { status: number; body?: unknown } | "fail";
  let asked: Array<{ url: string; credentials?: string }> = [];

  function answer(routes: Record<string, Answer>): void {
    asked = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      asked.push({ url, credentials: init.credentials });
      const route = routes[url] ?? { status: 404, body: { error: "not-found" } };
      if (route === "fail") return Promise.reject(new TypeError("offline"));
      return Promise.resolve(new Response(route.status === 204 ? null : JSON.stringify(route.body ?? {}), { status: route.status }));
    });
  }

  const boxes = () => [...document.querySelectorAll<HTMLInputElement>("#code input")];
  const shown = () => boxes().map((box) => box.value).join("|");
  const status = () => document.getElementById("status")!;

  function typeKey(value: string): void {
    const box = boxes().find((candidate) => candidate === document.activeElement);
    if (!box || box.disabled) return;
    box.value = value;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const link = () => document.getElementById("usecode") as HTMLButtonElement;
  const boxesHidden = () => document.getElementById("boxes")!.hidden;
  const reveal = () => {
    if (!link().hidden) link().click();
  };

  function enter(text: string): void {
    reveal();
    if (document.activeElement === document.body) boxes()[0]!.focus();
    for (const ch of text) typeKey(ch);
  }

  function paste(text: string, into = 0): void {
    reveal();
    const box = boxes()[into]!;
    box.focus();
    const event = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), { clipboardData: { getData: () => text } });
    box.dispatchEvent(event);
  }

  function key(name: string): void {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  }

  const focused = () => boxes().findIndex((box) => box === document.activeElement);
  const live = { [LOOKUP]: { status: 200, body: { label: LABEL_A } }, [CHECK]: { status: 204 } } satisfies Record<string, Answer>;

  it("offers the code on a cold start only", () => {
    open("/signin", []);
    expect(document.getElementById("code")?.hidden).toBe(false);
    open(`/signin?pc=${LABEL_A}&m=${M}`, [{ label: LABEL_A, name: "Ada" }]);
    expect(document.getElementById("code")?.hidden).toBe(true);
  });

  it.each(["/signin?code=ABCDEF", "/signin#code=ABCDEF"])("starts with the boxes open on a link that carries a code: %s", (url) => {
    open(url, []);
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    expect(boxes()).toHaveLength(6);
    expect(shown()).toBe("|||||");
  });

  it("keeps the boxes out of sight behind a link a keyboard can reach", () => {
    open("/signin", []);
    expect(link().tagName).toBe("BUTTON");
    expect(link().type).toBe("button");
    expect(link().hidden).toBe(false);
    expect(link().tabIndex).toBe(0);
    expect(link().textContent).toBe("Use a code from Wink on your PC");
    expect(link().classList.contains("privacy")).toBe(true);
    expect(boxesHidden()).toBe(true);
    expect(document.querySelector("#code .quiet")).toBeNull();
  });

  it("shows the boxes with the cursor in the first one on a single tap of the link", () => {
    open("/signin", []);
    link().click();
    expect(link().hidden).toBe(true);
    expect(boxesHidden()).toBe(false);
    expect(boxes()).toHaveLength(6);
    expect(focused()).toBe(0);
  });

  it("opens on a paste right after the link tap, with no further click", async () => {
    open("/signin", []);
    answer(live);
    link().click();
    const event = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), { clipboardData: { getData: () => "abcdef" } });
    document.activeElement!.dispatchEvent(event);
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(asked.map((call) => call.url)).toEqual([LOOKUP, CHECK]);
  });

  const covered = () => document.getElementById("code")?.classList.contains("trying");
  const inert = () => document.getElementById("code")?.hasAttribute("inert");

  function stubNavigation(): EventTarget {
    const navigation = new EventTarget();
    vi.stubGlobal("navigation", navigation);
    return navigation;
  }

  it("keeps the boxes see-through and inert while a remembered PC opens", async () => {
    stubNavigation();
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }]);
    expect(covered()).toBe(true);
    expect(inert()).toBe(true);
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1")));
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(covered()).toBe(true);
    expect(inert()).toBe(true);
  });

  it("shows usable boxes when the open is stopped and the page stays", async () => {
    const navigation = stubNavigation();
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }]);
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1")));
    navigation.dispatchEvent(new Event("navigateerror"));
    expect(covered()).toBe(false);
    expect(inert()).toBe(false);
    expect(boxes()).toHaveLength(6);
    expect(boxes().every((box) => !box.disabled)).toBe(true);
  });

  it("does not cover the boxes where the page cannot hear a stopped open", () => {
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }]);
    expect(covered()).toBe(false);
    expect(inert()).toBe(false);
  });

  it("opens the boxes with the cursor in the first one when a remembered PC's open is stopped", async () => {
    const navigation = stubNavigation();
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }]);
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1")));
    expect(boxesHidden()).toBe(true);
    navigation.dispatchEvent(new Event("navigateerror"));
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    expect(focused()).toBe(0);
  });

  it("opens the boxes when the remembered PC does not answer", async () => {
    stubNavigation();
    vi.useFakeTimers();
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }], undefined, "timeout");
    await vi.advanceTimersByTimeAsync(1999);
    expect(boxesHidden()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
  });

  it("keeps the boxes behind the link while a remembered PC opens where the page cannot hear a stopped open", async () => {
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }]);
    expect(boxesHidden()).toBe(true);
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1")));
    expect(boxesHidden()).toBe(true);
    expect(link().hidden).toBe(false);
  });

  it.each([
    ["/signin?code=ABCDEF", false],
    ["/signin#code=ABCDEF", false],
    ["/signin?code=ABCDEF", true],
    ["/signin#code=ABCDEF", true],
  ])("keeps the boxes behind the link while a remembered PC opens from a link that carries a code: %s, Navigation API %s", async (url, nav) => {
    if (nav) stubNavigation();
    localStorage.setItem(LAST_PC, LABEL_B);
    open(url, [{ label: LABEL_B, name: "Zed" }]);
    expect(boxesHidden()).toBe(true);
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1")));
    expect(boxesHidden()).toBe(true);
    expect(link().hidden).toBe(false);
  });

  it.each(["/signin?code=ABCDEF", "/signin#code=ABCDEF"])("opens the boxes on a link that carries a code when the remembered PC is offline: %s", async (url) => {
    localStorage.setItem(LAST_PC, LABEL_B);
    open(url, [{ label: LABEL_B, name: "Zed" }], undefined, "down");
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    expect(shown()).toBe("|||||");
  });

  it("opens the boxes when a bookmark changes an open sign-in page to a code link", () => {
    open("/signin", []);
    expect(boxesHidden()).toBe(true);
    history.replaceState(null, "", "/signin#code=ABCDEF");
    window.dispatchEvent(new Event("hashchange"));
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    expect(boxes()).toHaveLength(6);
    expect(boxes().every((box) => !box.disabled)).toBe(true);
  });

  it("opens the boxes when the remembered PC is offline where the page cannot hear a stopped open", async () => {
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }], undefined, "down");
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
  });

  async function chooseAda(probe = "up"): Promise<void> {
    open("/signin", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }], undefined, probe);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    expect(boxesHidden()).toBe(true);
    document.querySelector<HTMLButtonElement>("#list button")!.click();
  }

  it("opens the boxes with the cursor in the first one when a chosen PC is offline", async () => {
    await chooseAda("down");
    await vi.waitFor(() => expect(status().textContent).toBe("Ada is offline."));
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    expect(focused()).toBe(0);
  });

  it("opens the boxes with the cursor in the first one when a chosen PC's open is stopped", async () => {
    const navigation = stubNavigation();
    await chooseAda();
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1&n=Ada")));
    expect(boxesHidden()).toBe(true);
    navigation.dispatchEvent(new Event("navigateerror"));
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    expect(focused()).toBe(0);
  });

  it("opens the boxes with the cursor in the first one when the PC list answers 503", async () => {
    open("/signin", []);
    answer({ [`https://relay.${BASE}/v1/pcs`]: { status: 503, body: { error: "unavailable" } } });
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(status().textContent).toBe(OFFLINE));
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    expect(focused()).toBe(0);
  });

  it.each([
    ["the PC list cannot be reached", "fail" as const, undefined, OFFLINE],
    ["no PC is signed in", [] as Pc[], undefined, EMPTY],
    ["Google sign-in breaks", [] as Pc[], GIS_BOOM, GOOGLE_DOWN],
  ])("opens the boxes with the cursor in the first one when %s", async (_why, body, gisError, said) => {
    open("/signin", body, gisError);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(status().textContent).toBe(said));
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    expect(focused()).toBe(0);
  });

  it.each<[string, Answer, string]>([
    ["answers 503", { status: 503, body: { error: "unavailable" } }, OFFLINE],
    ["cannot be reached", "fail", OFFLINE],
    ["comes back empty", { status: 200, body: [] }, EMPTY],
  ])("keeps the cursor and the typed letters when the PC list %s after the boxes were opened", async (_why, late, said) => {
    open("/signin", []);
    answer(live);
    const routed = globalThis.fetch;
    let settle!: () => void;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
      url === `https://relay.${BASE}/v1/pcs`
        ? new Promise<Response>((resolve, reject) => {
            settle = () => (late === "fail" ? reject(new TypeError("offline")) : resolve(new Response(JSON.stringify(late.body), { status: late.status })));
          })
        : routed(url, init),
    );
    inits[0]!.callback({ credential: DIR_TOKEN });
    enter("AB");
    expect(focused()).toBe(2);
    await vi.waitFor(() => expect(settle).toBeTypeOf("function"));
    settle();
    await vi.waitFor(() => expect(status().textContent).toBe(said));
    expect(shown()).toBe("A|B||||");
    expect(focused()).toBe(2);
    enter("CDEF");
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
  });

  it("shows the boxes when Back restores the page after a remembered PC opened", async () => {
    stubNavigation();
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }]);
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1")));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(covered()).toBe(true);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(covered()).toBe(false);
    expect(inert()).toBe(false);
    expect(boxes()).toHaveLength(6);
  });

  it("shows the boxes when the remembered PC does not answer, and not before", async () => {
    stubNavigation();
    vi.useFakeTimers();
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [{ label: LABEL_B, name: "Zed" }], undefined, "timeout");
    await vi.advanceTimersByTimeAsync(1999);
    expect(covered()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(covered()).toBe(false);
    expect(inert()).toBe(false);
    expect(boxes()).toHaveLength(6);
  });

  it("is six boxes that ask the phone for a one-time code, and no Open button", () => {
    open("/signin", []);
    expect(boxes()).toHaveLength(6);
    expect(boxes().every((box) => box.autocomplete === "one-time-code" && box.maxLength !== 1)).toBe(true);
    expect(boxes().every((box) => box.getAttribute("enterkeyhint") === "go")).toBe(true);
    expect(document.querySelector("#boxes button")).toBeNull();
    expect(boxes().map((box) => box.getAttribute("aria-label"))).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Code ${n}`));
  });

  it("looks like the group join boxes", () => {
    const tsx = readFileSync(join(ROOT, "src/components/CodeBoxes.tsx"), "utf8");
    expect(tsx).toContain("size-11 rounded-lg border border-hairline/60 bg-inset text-center font-mono text-[18px] font-semibold");
    const rule = CSS.match(/\.boxes input \{([^}]*)\}/)?.[1] ?? "";
    for (const part of ["width: 44px", "height: 44px", "border-radius: var(--radius-lg)", "var(--hairline) 60%", "var(--inset)", "text-align: center", "font: 600 18px ui-monospace"]) expect(rule).toContain(part);
    expect(CSS).toMatch(/\.boxes \{[^}]*gap: 8px/);
  });

  it("rounds the boxes like the app's group join boxes in the skin this page matches", () => {
    const app = readFileSync(join(ROOT, "src/styles.css"), "utf8");
    const radius = (selector: string, css: string) => css.match(new RegExp(`${selector.replace(/[[\]"=\-^]/g, "\\$&")} \\{[^}]*?--radius-lg: (\\d+px)`))?.[1];
    const light = CSS.match(/:root \{[^}]*--radius-lg: (\d+px)/)?.[1];
    const dark = CSS.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*--radius-lg: (\d+px)/)?.[1];
    expect(light).toBe(radius('[data-skin="wink-day"]', app));
    expect(dark).toBe(radius('[data-skin="precision"]', app));
    expect([light, dark]).toEqual(["18px", "6px"]);
  });

  it("lets Tab leave the boxes forward instead of back into the next empty one", () => {
    open("/signin", []);
    answer({});
    const stops = () => boxes().map((box) => box.tabIndex);
    expect(stops()).toEqual([0, -1, -1, -1, -1, -1]);
    enter("AB");
    expect(stops()).toEqual([0, 0, 0, -1, -1, -1]);
    enter("CDEF");
    expect(stops()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("types like the group boxes for any text, Korean keyboard included", () => {
    const samples = ["abc-def", " ab0 ", "ㅁㅠㅊㅇㄷㄹ", "한글ㅂ", "ᄀ각", "O0I1L", "z9y8", "ＡＢＣ"];
    for (const sample of samples) {
      open("/signin", []);
      answer({});
      enter(sample);
      expect(boxes().map((box) => box.value).join("")).toBe(shortCodeChars(sample).slice(0, 6));
    }
  });

  it("moves to the next box on each character and shows uppercase", () => {
    open("/signin", []);
    answer({});
    enter("a");
    expect(shown()).toBe("A|||||");
    expect(focused()).toBe(1);
    enter("bc");
    expect(shown()).toBe("A|B|C|||");
    expect(focused()).toBe(3);
  });

  it("opens by itself on the sixth character, with no submit", async () => {
    open("/signin", []);
    answer(live);
    enter("ABCDE");
    expect(asked).toEqual([]);
    enter("F");
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(asked).toEqual([{ url: LOOKUP, credentials: "omit" }, { url: CHECK, credentials: "omit" }]);
  });

  it("disables the boxes while it checks", async () => {
    open("/signin", []);
    answer({ [LOOKUP]: { status: 404 } });
    enter("ABCDEF");
    expect(boxes().every((box) => box.disabled)).toBe(true);
    await vi.waitFor(() => expect(boxes().every((box) => !box.disabled)).toBe(true));
  });

  it("fills all six boxes from a paste and opens", async () => {
    open("/signin", []);
    answer(live);
    paste(" abc-def ");
    expect(shown()).toBe("A|B|C|D|E|F");
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(asked.map((call) => call.url)).toEqual([LOOKUP, CHECK]);
  });

  it("fills as many boxes as a short paste has and waits for the rest", () => {
    open("/signin", []);
    answer({});
    paste("abc");
    expect(shown()).toBe("A|B|C|||");
    expect(focused()).toBe(3);
    expect(asked).toEqual([]);
  });

  it("ignores a paste that is not a short code", () => {
    open("/signin", []);
    answer({});
    paste("abcdefghij");
    paste("0O1I");
    expect(shown()).toBe("|||||");
    expect(asked).toEqual([]);
  });

  it("goes back a box on Backspace in an empty box, clearing the one before", () => {
    open("/signin", []);
    answer({});
    enter("AB");
    expect(focused()).toBe(2);
    key("Backspace");
    expect(shown()).toBe("A|||||");
    expect(focused()).toBe(1);
    key("Backspace");
    expect(shown()).toBe("|||||");
    expect(focused()).toBe(0);
    key("Backspace");
    expect(shown()).toBe("|||||");
    expect(focused()).toBe(0);
  });

  it("clears only the box Backspace is on and keeps the letters after it", () => {
    open("/signin", []);
    answer({});
    enter("ABC");
    boxes()[0]!.focus();
    key("Backspace");
    expect(shown()).toBe("|B|C|||");
    expect(focused()).toBe(0);
    enter("X");
    expect(shown()).toBe("X|B|C|||");
  });

  it("does not open until a cleared box mid-code is filled again", async () => {
    open("/signin", []);
    answer(live);
    enter("ABCDE");
    boxes()[1]!.focus();
    key("Backspace");
    boxes()[4]!.focus();
    enter("F");
    expect(asked).toEqual([]);
  });

  it("says the same plain words and starts over on the first box for a wrong code", async () => {
    open("/signin", []);
    answer({});
    enter("ABCDEF");
    await vi.waitFor(() => expect(status().textContent).toBe(BAD_CODE));
    expect(status().className).toBe("status error");
    expect(shown()).toBe("|||||");
    expect(boxes().every((box) => !box.disabled)).toBe(true);
    expect(focused()).toBe(0);
    expect(boxesHidden()).toBe(false);
    expect(link().hidden).toBe(true);
    answer(live);
    enter("ABCDEF");
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(status().textContent).toBe("");
  });

  it("does not remember a PC for a typed code, so the next visit sends this browser nowhere until Google signs in", async () => {
    open("/signin", []);
    answer(live);
    enter("ABCDEF");
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(localStorage.getItem(LAST_PC)).toBeNull();
    open("/signin", []);
    expect(probes).toEqual([]);
    expect(location.href).not.toContain("/pair");
    expect(inits).toHaveLength(1);
  });

  it.each<[string, Record<string, Answer>]>([
    ["no such code", {}],
    ["a code the PC no longer holds", { [LOOKUP]: { status: 200, body: { label: LABEL_A } } }],
    ["a PC that is off", { [LOOKUP]: { status: 200, body: { label: LABEL_A } }, [CHECK]: "fail" }],
    ["the PC's rate limit", { [LOOKUP]: { status: 200, body: { label: LABEL_A } }, [CHECK]: { status: 429 } }],
    ["a relay that answers nonsense", { [LOOKUP]: { status: 200, body: { label: "../evil" } } }],
    ["a relay that cannot be reached", { [LOOKUP]: "fail" }],
  ])("says the same plain words for %s", async (_, routes) => {
    open("/signin", []);
    answer(routes);
    enter("ABCDEF");
    await vi.waitFor(() => expect(status().textContent).toBe(BAD_CODE));
    expect(status().className).toBe("status error");
    expect(location.href).not.toContain("/pair");
    expect(shown()).toBe("|||||");
    expect(focused()).toBe(0);
  });

  it.each(["", "ABCDE", "ABCDE0", "OOOOOO"])("asks no one for %j", (typed) => {
    open("/signin", []);
    answer({});
    enter(typed);
    expect(asked).toEqual([]);
  });

  it("asks only for the first six characters when more are typed", async () => {
    open("/signin", []);
    answer(live);
    enter("ABCDEFG");
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(asked.map((call) => call.url)).toEqual([LOOKUP, CHECK]);
  });

  it("asks the person to wait on the relay's rate limit, and lets them type again", async () => {
    open("/signin", []);
    answer({ [LOOKUP]: { status: 429, body: { error: "rate-limited" } } });
    enter("ABCDEF");
    await vi.waitFor(() => expect(status().textContent).toBe("Too many tries. Wait a minute and try again."));
    expect(asked.map((call) => call.url)).toEqual([LOOKUP]);
    expect(shown()).toBe("|||||");
    expect(boxes().every((box) => !box.disabled)).toBe(true);
  });

  it("starts over, on the first box, when Back restores the page after a typed code", async () => {
    open("/signin", []);
    answer(live);
    enter("ABCDEF");
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(boxes().every((box) => box.disabled)).toBe(true);
    status().textContent = BAD_CODE;
    status().className = "status error";
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(boxes().every((box) => !box.disabled)).toBe(true);
    expect(shown()).toBe("|||||");
    expect(focused()).toBe(0);
    expect(status().textContent).toBe("");
    expect(status().className).toBe("status");
    expect(boxesHidden()).toBe(false);
  });

  it("does not pull focus into the boxes when Back restores the page after a listed PC", async () => {
    open("/?pick=1", [{ label: LABEL_A, name: "Ada" }, { label: LABEL_B, name: "Zed" }]);
    inits[0]!.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    document.querySelector<HTMLButtonElement>("#list button")!.click();
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1&n=Ada")));
    enter("AB");
    boxes()[2]!.blur();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(focused()).toBe(-1);
    expect(shown()).toBe("|||||");
    expect(boxes().every((box) => !box.disabled)).toBe(true);
  });

  it("leaves a fresh page load alone on pageshow", () => {
    open("/signin", []);
    answer({});
    enter("AB");
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(shown()).toBe("A|B||||");
  });

  it("sends one lookup when the boxes are filled twice at once", async () => {
    open("/signin", []);
    answer(live);
    enter("ABCDEF");
    enter("ABCDEF");
    paste("ABCDEF");
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(asked.map((call) => call.url)).toEqual([LOOKUP, CHECK]);
  });
});
