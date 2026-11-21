// Phone sign-in at the one registered Google origin. The PC-bound token
// leaves this page only for the relay's PC list and the fragment of the PC
// it was bound to; it works at that PC only with this browser's cookie.
(() => {
  // 16 chars, lowercase base32, same alphabet as relay labels.
  const LABEL_RE = /^[a-z2-7]{16}$/;
  const M_RE = /^[A-Za-z0-9_-]{43}$/;
  const PHONE_RE = /iPhone|iPod|Android.*Mobile/;
  const CLIENT_RE = /^[0-9A-Za-z_-]+(?:\.[0-9A-Za-z_-]+)*\.apps\.googleusercontent\.com$/;
  const BASE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  const LAST_PC = "wink-signin-pc";
  const ACCOUNT = "wink-signin-account";
  const OPENING = "wink-signin-opening";
  const EMPTY = "Sign in with Google in Wink on your PC first: Settings, Devices.";
  const OFFLINE = "Could not reach your PC. Check your connection and try again.";
  const BAD_LINK = "That PC link is not valid.";
  const NOT_YOURS = "That PC is not signed in to this Google account.";
  const UNCONFIGURED = "Sign-in is not configured.";
  const GOOGLE_DOWN = "Could not load Google sign-in. Check your connection and try again.";
  // One message for every miss, so a wrong code never tells whether a PC is behind it.
  const BAD_CODE = "That code did not work. Check it in Wink on your PC: Settings, Devices.";
  const TOO_MANY = "Too many tries. Wait a minute and try again.";

  let gis = null;
  let config = null;
  let listed = [];
  let account = "";
  let showBoxes = () => {};

  const $ = (id) => document.getElementById(id);
  const say = (text, tone) => {
    if (tone === "error" && $("title").querySelector(".spinner")) $("title").textContent = "Sign in";
    const status = $("status");
    status.textContent = text;
    status.className = tone ? `status ${tone}` : "status";
  };
  const text = (value) => (Object.prototype.toString.call(value) === "[object String]" ? value : "");

  function b64url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }

  function randomNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return b64url(bytes);
  }

  // Null bytes keep the label and m from sliding into each other.
  async function boundNonce(pc, m) {
    const data = new TextEncoder().encode(`wink-gpair/1\0${pc}\0${m}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return b64url(digest);
  }

  function readConfig() {
    const raw = globalThis.WINK_SIGNIN;
    if (Object.prototype.toString.call(raw) !== "[object Object]") return null;
    const clientId = text(raw.clientId);
    const base = text(raw.base);
    if (!CLIENT_RE.test(clientId) || !BASE_RE.test(base)) return null;
    return { clientId, base };
  }

  function remembered() {
    try {
      return localStorage.getItem(LAST_PC) || "";
    } catch {
      return "";
    }
  }

  function remember(label) {
    try {
      localStorage.setItem(LAST_PC, label);
    } catch {}
  }

  function subject(token) {
    try {
      const part = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
      return text(JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))).sub);
    } catch {
      return "";
    }
  }

  // The cold start's account, for the PC being opened: the token on the way back is asked for by name and must match.
  function holdAccount(label) {
    try {
      if (account) sessionStorage.setItem(ACCOUNT, `${label}:${account}`);
      else sessionStorage.removeItem(ACCOUNT);
    } catch {}
  }

  function takeAccount(label) {
    try {
      const held = sessionStorage.getItem(ACCOUNT) || "";
      sessionStorage.removeItem(ACCOUNT);
      return held.startsWith(`${label}:`) ? held.slice(label.length + 1) : "";
    } catch {
      return "";
    }
  }

  // The PC being opened, by name, for this page's return leg and the PC's own page.
  function holdName(label, name) {
    try {
      if (name) sessionStorage.setItem(OPENING, `${label}:${name}`);
      else sessionStorage.removeItem(OPENING);
    } catch {}
  }

  function heldName(label) {
    try {
      const held = sessionStorage.getItem(OPENING) || "";
      return held.startsWith(`${label}:`) ? held.slice(label.length + 1) : "";
    } catch {
      return "";
    }
  }

  function spinner() {
    const spin = document.createElement("span");
    spin.className = "spinner";
    spin.setAttribute("aria-hidden", "true");
    return spin;
  }

  function opening(name) {
    $("title").replaceChildren(spinner(), `Opening ${name || "Wink"}…`);
  }

  function decodePcs(payload) {
    if (!Array.isArray(payload)) return null;
    const pcs = [];
    for (const row of payload) {
      if (Object.prototype.toString.call(row) !== "[object Object]") continue;
      const label = text(row.label);
      if (!LABEL_RE.test(label)) continue;
      const name = text(row.name).trim();
      pcs.push({ label, name: name || label });
    }
    return pcs;
  }

  async function loadPcs(token) {
    try {
      const response = await fetch(`https://relay.${config.base}/v1/pcs`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) return null;
      return decodePcs(await response.json());
    } catch {
      return null;
    }
  }

  function go(label, suffix, name = "") {
    if (!LABEL_RE.test(label)) {
      say(BAD_LINK, "error");
      return;
    }
    remember(label);
    holdAccount(label);
    holdName(label, name);
    // A stopped open leaves this page up, and the code is the other way in.
    globalThis.navigation?.addEventListener("navigateerror", () => showBoxes(true), { once: true });
    location.assign(`https://${label}.${config.base}/pair${suffix}${name ? `&n=${encodeURIComponent(name)}` : ""}`);
  }

  function reachable(label) {
    return new Promise((resolve) => {
      const image = new Image();
      const finish = (online) => {
        clearTimeout(timeout);
        // Clearing src can fire onerror; detach handlers first.
        image.onload = null;
        image.onerror = null;
        image.src = "";
        resolve(online);
      };
      const timeout = setTimeout(() => finish(false), 2000);
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.referrerPolicy = "no-referrer";
      image.src = `https://${label}.${config.base}/app-icon.svg?probe=${Date.now()}`;
    });
  }

  async function openPc(button, pc) {
    if (button.disabled) return;
    for (const other of $("list").children) other.disabled = true;
    button.replaceChildren(spinner(), `Opening ${pc.name}…`);
    button.setAttribute("aria-busy", "true");
    // A PC that left the relay has no certificate, so the browser would land on a raw TLS error page.
    if (await reachable(pc.label)) {
      go(pc.label, "?g=1", pc.name);
      return;
    }
    showList(listed);
    say(`${pc.name} is offline.`, "error");
    showBoxes(true);
  }

  function showList(pcs) {
    listed = pcs;
    $("title").textContent = "Choose a PC";
    say("");
    const list = $("list");
    list.hidden = false;
    list.replaceChildren();
    const sorted = pcs.slice().sort((a, b) => a.name.localeCompare(b.name) || a.label.localeCompare(b.label));
    const last = remembered();
    for (const pc of sorted) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = pc.name;
      button.classList.toggle("last", pc.label === last);
      button.addEventListener("click", () => openPc(button, pc));
      list.append(button);
    }
  }

  function choose(pcs, pick = false) {
    if (pcs.length === 0) {
      say(EMPTY);
      showBoxes(true);
      return;
    }
    if (pick) {
      showList(pcs);
      return;
    }
    if (pcs.length === 1) {
      go(pcs[0].label, "?g=1", pcs[0].name);
      return;
    }
    const hit = pcs.find((pc) => pc.label === remembered());
    if (hit) {
      go(hit.label, "?g=1", hit.name);
      return;
    }
    showList(pcs);
  }

  // The relay names the PC; the PC then confirms the code is still its own, so turning phone access off ends it.
  async function codeLabel(code) {
    try {
      const found = await fetch(`https://relay.${config.base}/v1/room-codes/${code}`, { method: "GET", cache: "no-store", credentials: "omit" });
      if (found.status === 429) return "busy";
      if (!found.ok) return "";
      const label = text((await found.json())?.label);
      if (!LABEL_RE.test(label)) return "";
      const live = await fetch(`https://${label}.${config.base}/api/phone/open-code?c=${code}`, { method: "GET", cache: "no-store", credentials: "omit" });
      return live.status === 204 ? label : "";
    } catch {
      return "";
    }
  }

  // Same rules as src/components/CodeBoxes.tsx; signin.test.ts checks they agree.
  const CODE_LENGTH = 6;
  const CODE_KEEP = /[^2-9A-HJ-NP-Z]/g;
  const CODE_PASTED = /^[2-9A-HJ-NP-Z]{1,6}$/;
  // With Korean input on, letters arrive as Hangul; NFKD turns IME jamo and syllables into conjoining jamo, keyed here by 2-set layout.
  const HANGUL_KEYS = [
    [0x1100, "R R S E E F A Q Q T T D W W C Z X V G".split(" ")],
    [0x1161, "K O I O J P U P H HK HO HL Y N NJ NP NL B M ML L".split(" ")],
    [0x11a8, "R R RT S SW SG E F FR FA FQ FT FX FV FG A Q QT T T D W C Z X V G".split(" ")],
  ];

  function keyOf(ch) {
    const point = ch.codePointAt(0);
    for (const [start, keys] of HANGUL_KEYS) if (point >= start && point < start + keys.length) return keys[point - start];
    return ch;
  }

  const shortCodeChars = (value) => [...value.normalize("NFKD")].map(keyOf).join("").toUpperCase().replace(CODE_KEEP, "");

  // Shown at once but see-through and inert while a remembered PC may open, so the boxes do not flash. Stopping that open fires navigateerror here; with no Navigation API nothing could bring them back, so they are not covered and stay behind the link.
  function coverCode() {
    const nav = globalThis.navigation;
    if (!nav) return () => showBoxes(false);
    const code = $("code");
    const uncover = () => {
      code.classList.remove("trying");
      code.removeAttribute("inert");
      nav.removeEventListener("navigateerror", uncover);
      showBoxes(false);
    };
    code.classList.add("trying");
    code.setAttribute("inert", "");
    nav.addEventListener("navigateerror", uncover);
    return uncover;
  }

  function showCode() {
    $("code").hidden = false;
    const boxes = [];
    let value = "";
    let busy = false;
    // Back from a typed code lands where the person was typing; from a listed PC it does not pull focus into the boxes.
    let typed = false;

    // Only the boxes up to the next empty one are tab stops, so Tab walks forward out of the boxes rather than being pulled back by the focus rule.
    const render = () =>
      boxes.forEach((box, i) => {
        box.value = (value[i] || "").trim();
        box.tabIndex = i <= value.length ? 0 : -1;
      });
    const focusAt = (i) => boxes[Math.min(i, CODE_LENGTH - 1)].focus();
    const lock = (on) => {
      busy = on;
      for (const box of boxes) box.disabled = on;
    };

    const reset = () => {
      value = "";
      render();
      lock(false);
    };

    async function open(code) {
      lock(true);
      say("");
      const label = await codeLabel(code);
      // Then the same Google check as picking the PC from the list. Not remembered here: the return leg remembers it once Google says it is this account's.
      if (LABEL_RE.test(label)) {
        holdAccount(label);
        typed = true;
        location.assign(`https://${label}.${config.base}/pair?g=1`);
        return;
      }
      reset();
      focusAt(0);
      say(label === "busy" ? TOO_MANY : BAD_CODE, "error");
    }

    const put = (from, chars, keep = false) => {
      value = (value.slice(0, from) + chars + (keep ? value.slice(from + chars.length) : "")).slice(0, CODE_LENGTH);
      render();
      focusAt(from + chars.length);
      if (value.length === CODE_LENGTH && !value.includes(" ")) void open(value);
    };

    for (let i = 0; i < CODE_LENGTH; i++) {
      const box = document.createElement("input");
      box.setAttribute("aria-label", `Code ${i + 1}`);
      box.inputMode = "text";
      box.autocomplete = "one-time-code";
      box.setAttribute("autocapitalize", "characters");
      box.setAttribute("autocorrect", "off");
      box.spellcheck = false;
      box.setAttribute("enterkeyhint", "go");
      box.addEventListener("focus", () => {
        if (i > value.length) focusAt(value.length);
        else box.select();
      });
      box.addEventListener("input", () => {
        if (busy) return;
        const chars = shortCodeChars(box.value.replace(value[i] || "", ""));
        if (chars) put(Math.min(i, value.length), chars, chars.length === 1);
        else render();
      });
      box.addEventListener("paste", (event) => {
        event.preventDefault();
        if (busy) return;
        const chars = (event.clipboardData?.getData("text/plain") || "").trim().toUpperCase().replace(/[\s-]/g, "");
        if (CODE_PASTED.test(chars)) put(0, chars);
      });
      box.addEventListener("keydown", (event) => {
        if (event.key !== "Backspace") return;
        event.preventDefault();
        if (busy) return;
        const at = (value[i] || "").trim() ? i : i - 1;
        if (at < 0) return;
        // A cleared box mid-code holds a space, so the boxes after it keep their letters.
        value = `${value.slice(0, at)} ${value.slice(at + 1)}`.trimEnd();
        render();
        focusAt(at);
      });
      boxes.push(box);
    }
    render();
    $("boxes").replaceChildren(...boxes);
    // The boxes stay out of sight, and out of the tab order, until the person asks for them or the way to a PC falls through.
    showBoxes = (focus) => {
      $("usecode").hidden = true;
      $("boxes").hidden = false;
      if (focus) focusAt(0);
    };
    $("usecode").addEventListener("click", () => showBoxes(true));
    // Back from the PC's page can restore this one as it was left: locked on a code that already went.
    addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      reset();
      if (typed) focusAt(0);
      typed = false;
      say("");
    });
  }

  // Back from turning on Devices on the PC, the empty list loads again with the same token.
  function refreshWhenBack(token, pick) {
    let loading = false;
    const again = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const pcs = await loadPcs(token);
        if (!pcs || pcs.length === 0) return;
        removeEventListener("focus", again);
        document.removeEventListener("visibilitychange", again);
        choose(pcs, pick);
      } finally {
        loading = false;
      }
    };
    addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
  }

  function credentialFrom(response) {
    if (Object.prototype.toString.call(response) !== "[object Object]") return "";
    return text(response.credential);
  }

  function promptFailed(moment) {
    try {
      if (moment.isDismissedMoment() && moment.getDismissedReason() === "credential_returned") return false;
      return moment.isNotDisplayed() || moment.isSkippedMoment() || moment.isDismissedMoment();
    } catch {
      return true;
    }
  }

  function hideGoogle() {
    const slot = $("google");
    if (!slot) return;
    slot.hidden = true;
    slot.replaceChildren();
  }

  // Google draws a plain button, then swaps in its own frame once it loads.
  function revealWhenDrawn(slot) {
    const reveal = () => {
      clearTimeout(timeout);
      observer.disconnect();
      slot.classList.add("ready");
    };
    const drawn = () => {
      const frame = slot.querySelector("iframe");
      if (frame && frame.offsetHeight > 0) reveal();
    };
    const observer = new MutationObserver(drawn);
    const timeout = setTimeout(reveal, 1500);
    observer.observe(slot, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    drawn();
  }

  function requestToken(nonce, autoSelect, account = "") {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buttonShown = false;
      const finish = (credential) => {
        if (settled || !credential) return;
        settled = true;
        hideGoogle();
        resolve(credential);
      };
      const showButton = () => {
        if (settled || buttonShown) return;
        const slot = $("google");
        if (!slot) return;
        buttonShown = true;
        $("title").textContent = "Sign in";
        slot.hidden = false;
        slot.classList.remove("ready");
        slot.classList.toggle("last", LABEL_RE.test(remembered()));
        slot.replaceChildren();
        gis.renderButton(slot, {
          type: "standard",
          theme: matchMedia("(prefers-color-scheme: dark)").matches ? "filled_black" : "outline",
          size: "large",
          text: "signin_with",
          shape: "pill",
          width: 300,
        });
        revealWhenDrawn(slot);
      };
      const options = {
        client_id: config.clientId,
        callback: (response) => finish(credentialFrom(response)),
        nonce,
        auto_select: autoSelect,
        // popup returns the token to the callback. A redirect would post it to a URL.
        ux_mode: "popup",
      };
      if (account) options.login_hint = account;
      try {
        gis.cancel();
        gis.initialize(options);
      } catch (error) {
        reject(error);
        return;
      }
      if (!autoSelect) {
        showButton();
        return;
      }
      try {
        gis.prompt((moment) => {
          if (!settled && promptFailed(moment)) showButton();
        });
      } catch {
        showButton();
      }
    });
  }

  async function coldStart(pick) {
    const last = remembered();
    const saved = LABEL_RE.test(last);
    const uncover = !pick && saved ? coverCode() : () => {};
    if (!pick && saved && await reachable(last)) {
      // Back restores this page from bfcache as it was left, still covered.
      const restored = (event) => {
        if (!event.persisted) return;
        removeEventListener("pageshow", restored);
        uncover();
      };
      addEventListener("pageshow", restored);
      go(last, "?g=1");
      return;
    }
    uncover();
    // From a PC the account is usually known to Google, so try its quiet sign-in before drawing the button.
    if (pick) $("title").textContent = "Choose a PC";
    const token = await requestToken(randomNonce(), pick);
    account = subject(token);
    const listed = await loadPcs(token);
    if (!listed) {
      say(OFFLINE, "error");
      showBoxes(true);
      return;
    }
    choose(listed, pick || saved);
    if (listed.length === 0) refreshWhenBack(token, pick || saved);
  }

  async function returnLeg(pc, m) {
    // One prompt: Google stays quiet on a second auto_select within minutes and asks for the account again.
    const held = takeAccount(pc);
    const name = heldName(pc);
    const pcToken = await requestToken(await boundNonce(pc, m), true, held);
    const listed = await loadPcs(pcToken);
    if (!listed) {
      say(OFFLINE, "error");
      return;
    }
    if (!listed.some((row) => row.label === pc) || (held && subject(pcToken) !== held)) {
      say(NOT_YOURS, "error");
      return;
    }
    go(pc, `#g=${encodeURIComponent(pcToken)}`, name);
  }

  function googleId() {
    const google = globalThis.google;
    if (!google || !google.accounts || !google.accounts.id) return null;
    return google.accounts.id;
  }

  function whenGoogle() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const id = googleId();
        if (id) {
          resolve(id);
          return;
        }
        if (Date.now() - started > 15000) {
          reject(new Error("google"));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function run(id) {
    gis = id;
    config = readConfig();
    if (!config) {
      say(UNCONFIGURED, "error");
      return;
    }
    const params = new URLSearchParams(location.search);
    const pc = params.get("pc");
    const m = params.get("m");
    if (pc === null && m === null) {
      showCode();
      void coldStart(params.get("pick") === "1").catch(() => {
        say(GOOGLE_DOWN, "error");
        showBoxes(true);
      });
      return;
    }
    // A cold start is already the chooser, so the link would only reload it.
    $("pick").hidden = false;
    if (pc === null || m === null || !LABEL_RE.test(pc) || !M_RE.test(m)) {
      say(BAD_LINK, "error");
      return;
    }
    void returnLeg(pc, m).catch(() => say(GOOGLE_DOWN, "error"));
  }

  if (PHONE_RE.test(navigator.userAgent)) $("subtitle").textContent = "Reach Wink on your PC from this phone.";
  const leg = new URLSearchParams(location.search);
  if (LABEL_RE.test(leg.get("pc") || "") && M_RE.test(leg.get("m") || "")) opening(heldName(leg.get("pc")));
  // Back from a PC restores this page from bfcache with the PC buttons still opening.
  addEventListener("pageshow", (event) => {
    if (event.persisted && !$("list").hidden) showList(listed);
  });

  const ready = googleId();
  if (ready) run(ready);
  else void whenGoogle().then(run).catch(() => say(GOOGLE_DOWN, "error"));
})();
