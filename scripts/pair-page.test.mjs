// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en, ko } from "../src/lib/i18n-catalog.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "public/pair.html"), "utf8");
const MARKUP = SOURCE.slice(SOURCE.indexOf("<main>"), SOURCE.indexOf("</main>") + "</main>".length);
const SCRIPT = SOURCE.slice(SOURCE.indexOf("<script>") + "<script>".length, SOURCE.indexOf("</script>"));

/** Runs public/pair.html at `url`; `answer` replies to its pairing request. */
function open(url, answer = () => new Promise(() => {})) {
  document.body.innerHTML = MARKUP;
  history.replaceState(null, "", url);
  vi.stubGlobal("fetch", vi.fn(answer));
  runInThisContext(SCRIPT);
  const $ = (id) => document.getElementById(id);
  return { help: $("help"), form: $("form"), status: $("status"), google: $("google"), code: $("code") };
}

/** Answers the Google start probe with `start` and the sign-in POST with `signIn`. */
function googlePc({ start = 204, signIn = () => new Response("{}", { status: 200 }) } = {}) {
  return async (url, init = {}) => {
    if (url === "/api/phone/google/start" && init.method === "HEAD") return new Response(null, { status: start });
    if (url === "/api/phone/google") return signIn(init);
    return new Promise(() => {});
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("pair page", () => {
  it("reuses the enabled-button press pattern", () => {
    expect(SOURCE).toMatch(/button:active:not\(:disabled\)\s*\{[^}]*transform: scale\(0\.99\)/);
    expect(SOURCE).toContain("transition: filter 150ms, transform 150ms");
  });

  it("shows only its progress while the QR link pairs on its own", () => {
    const page = open("/pair#k=wkp_token");
    expect(page.status.textContent).toBe("Pairing...");
    expect(page.help.hidden).toBe(true);
    expect(page.form.hidden).toBe(true);
    expect(location.hash).toBe("");
  });

  it("asks for the 6 digit code when opened without a link", () => {
    const page = open("/pair");
    expect(page.help.hidden).toBe(false);
    expect(page.help.textContent).toContain("6 digit code");
    expect(page.help.textContent).toContain(`Settings, ${en["settings.section.devices"]}, ${en["settings.devices.codeInstead"]}.`);
    expect(page.form.hidden).toBe(false);
  });

  it.each([
    // Named as Settings names them, so the page cannot point at a place Settings no longer has.
    ["en", en, `Get a new code on your PC: Settings, ${en["settings.section.devices"]}, ${en["settings.devices.codeInstead"]}.`],
    ["ko", ko, `PC의 설정 > ${ko["settings.section.devices"]} > ${ko["settings.devices.codeInstead"]}에서 새 코드를 받으세요.`],
  ])("sends a refused phone to Code instead of Google for a new code (%s)", async (locale, catalog, next) => {
    localStorage.setItem("omb-locale", locale);
    for (const error of ["no-pairing", "too-many-attempts", "something-else"]) {
      const page = open("/pair#k=wkp_token", async () => new Response(JSON.stringify({ error }), { status: 409 }));
      await vi.waitFor(() => expect(page.status.className).toBe("status error"));
      // The PC shows Add a phone or Make a new code depending on its state, so name neither.
      expect(page.status.textContent, error).toContain(next);
      expect(page.status.textContent, error).not.toContain(catalog["settings.phoneAccess.addPhone"]);
      expect(page.help.hidden).toBe(false);
      expect(page.form.hidden).toBe(false);
    }
  });

  it("shows one Continue with Google button above the code field when the PC can take it", async () => {
    const page = open("/pair", googlePc());
    await vi.waitFor(() => expect(page.google.hidden).toBe(false));
    expect(page.google.textContent.trim()).toBe("Continue with Google");
    expect(page.google.compareDocumentPosition(page.code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll(".google")).toHaveLength(1);
    expect(page.form.hidden).toBe(false);
  });

  it("keeps the button hidden when the PC can't take a Google sign-in", async () => {
    const page = open("/pair", googlePc({ start: 409 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.google.hidden).toBe(true);
    expect(page.form.hidden).toBe(false);
  });

  it("goes to the start route from the button, and on its own with ?g=1", async () => {
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    const page = open("/pair", googlePc());
    await vi.waitFor(() => expect(page.google.hidden).toBe(false));
    expect(assign).not.toHaveBeenCalled();
    page.google.click();
    expect(assign).toHaveBeenCalledExactlyOnceWith("/api/phone/google/start");
    assign.mockClear();
    open("/pair?g=1", googlePc());
    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/api/phone/google/start"));
    assign.mockClear();
    open("/pair?g=1", googlePc({ start: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(assign).not.toHaveBeenCalled();
  });

  it("draws none of its own sign-in on ?g=1 and hands to the Google sign-in page once", async () => {
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    const page = open("/pair?g=1&n=Home", googlePc());
    const title = document.getElementById("title");
    expect(title.textContent).toBe("Opening Home…");
    expect(title.querySelector(".spinner")).not.toBeNull();
    expect(title.textContent + page.status.textContent).not.toMatch(/sign in|pair/i);
    expect(page.help.hidden).toBe(true);
    expect(page.form.hidden).toBe(true);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/api/phone/google/start"));
    expect(page.form.hidden).toBe(true);
    expect(page.google.hidden).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["en", "Google sign-in isn't ready on this PC yet. Use the code."],
    ["ko", "이 PC에서는 아직 Google 로그인을 사용할 수 없습니다. 코드를 사용하세요."],
  ])("says why after ?g=1 when the PC can't take a Google sign-in yet (%s)", async (locale, text) => {
    localStorage.setItem("omb-locale", locale);
    const page = open("/pair?g=1", googlePc({ start: 409 }));
    await vi.waitFor(() => expect(page.status.textContent).toBe(text));
    expect(page.status.className).toBe("status");
    expect(page.google.hidden).toBe(true);
    expect(page.form.hidden).toBe(false);
    const plain = open("/pair", googlePc({ start: 409 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plain.status.textContent).toBe("");
  });

  it("reads and clears #g=, posts the token, then loads the app", async () => {
    const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
    const posted = [];
    const page = open("/pair#g=id.token.sig", googlePc({ signIn: (init) => (posted.push(init), new Response("{}", { status: 200 })) }));
    expect(location.hash).toBe("");
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(posted[0].body)).toEqual({ credential: "id.token.sig", name: "Phone" });
    expect(page.status.textContent).toBe("");
  });

  it.each([
    ["en", "/pair?g=1", "Opening Wink…"],
    ["en", "/pair#g=id.token.sig&n=Home", "Opening Home…"],
    ["ko", "/pair?g=1&n=Home", "Home 여는 중…"],
    ["ko", "/pair#g=id.token.sig", "Wink 여는 중…"],
  ])("titles the automatic Google path Opening <PC name>… with no pairing words (%s %s)", async (locale, url, text) => {
    localStorage.setItem("omb-locale", locale);
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
    const page = open(url, googlePc());
    const title = document.getElementById("title");
    expect(title.textContent).toBe(text);
    expect(title.querySelector(".spinner")).not.toBeNull();
    await vi.waitFor(() => expect(url.includes("?g=1") ? assign : replace).toHaveBeenCalledOnce());
    expect(title.textContent).toBe(text);
    expect(page.status.textContent).not.toMatch(/pair|연결/i);
    expect(page.help.hidden).toBe(true);
    expect(page.form.hidden).toBe(true);
  });

  it("keeps Pair this phone and the green Paired line for a QR link", async () => {
    vi.spyOn(location, "replace").mockImplementation(() => {});
    const page = open("/pair#k=wkp_token", async () => new Response("{}", { status: 200 }));
    expect(document.getElementById("title").textContent).toBe("Pair this phone");
    await vi.waitFor(() => expect(page.status.textContent).toBe("Paired. Opening Wink..."));
    expect(page.status.className).toBe("status ok");
  });

  describe("on a glasses lens", () => {
    const GLASSES = "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Safari/537.36";
    const FOLDABLE = "Mozilla/5.0 (Linux; Android 14; SM-F956N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const lens = (square, ua = GLASSES) => {
      vi.stubGlobal("matchMedia", (query) => ({ matches: square && query.includes("aspect-ratio"), media: query }));
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    };
    const glass = () => document.getElementById("glass");
    afterEach(() => document.body.removeAttribute("class"));

    it.each([
      ["?g=1 when the PC can't take Google", "/pair?g=1", googlePc({ start: 409 })],
      ["a refused Google sign-in", "/pair#g=id.token.sig", googlePc({ signIn: () => new Response(JSON.stringify({ error: "wrong-account" }), { status: 403 }) })],
    ])("falls back to the glasses code screen after %s", async (_, url, answer) => {
      lens(true);
      const page = open(url, answer);
      await vi.waitFor(() => expect(glass().hidden).toBe(false));
      expect(document.body.classList.contains("glasses")).toBe(true);
      expect(page.form.hidden).toBe(true);
      expect(document.activeElement?.id).toBe("g-code");
    });

    it.each([
      ["?g=1 when the PC can't take Google", "/pair?g=1", googlePc({ start: 409 })],
      ["a refused Google sign-in", "/pair#g=id.token.sig", googlePc({ signIn: () => new Response(JSON.stringify({ error: "wrong-account" }), { status: 403 }) })],
    ])("keeps the phone form after %s on a phone", async (_, url, answer) => {
      lens(false, FOLDABLE);
      const page = open(url, answer);
      await vi.waitFor(() => expect(page.form.hidden).toBe(false));
      expect(glass().hidden).toBe(true);
      expect(document.body.classList.contains("glasses")).toBe(false);
    });

    it("shows the glasses code screen and lands on /glasses in the glasses web view", async () => {
      const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
      lens(true);
      const page = open("/pair", googlePc());
      expect(glass().hidden).toBe(false);
      expect(page.form.hidden).toBe(true);
      open("/pair#k=wkp_token", async () => new Response("{}", { status: 200 }));
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/glasses"));
    });

    // A square window alone is an unfolded foldable, a split-screen phone or a small desktop window.
    it.each([
      ["an unfolded foldable", FOLDABLE],
      ["a small desktop window", DESKTOP],
      ["an iPhone in split view", IPHONE],
    ])("keeps the phone form, Google and / on a square window in %s", async (_, ua) => {
      const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
      lens(true, ua);
      const page = open("/pair", googlePc());
      await vi.waitFor(() => expect(page.google.hidden).toBe(false));
      expect(page.form.hidden).toBe(false);
      expect(glass().hidden).toBe(true);
      expect(document.body.classList.contains("glasses")).toBe(false);
      open("/pair#k=wkp_token", async () => new Response("{}", { status: 200 }));
      await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
      expect(replace).toHaveBeenCalledWith("/");
    });
  });

  it("names a wrong account and offers the code field after a refused Google sign-in", async () => {
    for (const [error, text] of [["wrong-account", "Use the Google account this PC is signed in with."], ["nonce-mismatch", "Google sign-in did not work. Try again, or enter the 6 digit code."]]) {
      const page = open("/pair#g=id.token.sig", googlePc({ signIn: () => new Response(JSON.stringify({ error }), { status: 403 }) }));
      await vi.waitFor(() => expect(page.status.className).toBe("status error"));
      expect(page.status.textContent).toBe(text);
      expect(page.form.hidden).toBe(false);
    }
  });
});
