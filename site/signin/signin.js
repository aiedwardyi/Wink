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
  const EMPTY = "Sign in with Google in Wink on your PC first: Settings, Sync.";
  const OFFLINE = "Could not reach your PC. Check your connection and try again.";
  const BAD_LINK = "That PC link is not valid.";
  const NOT_YOURS = "That PC is not signed in to this Google account.";
  const UNCONFIGURED = "Sign-in is not configured.";
  const GOOGLE_DOWN = "Could not load Google sign-in. Check your connection and try again.";

  let gis = null;
  let config = null;
  let listed = [];

  const $ = (id) => document.getElementById(id);
  const say = (text, tone) => {
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

  function go(label, suffix) {
    if (!LABEL_RE.test(label)) {
      say(BAD_LINK, "error");
      return;
    }
    remember(label);
    location.assign(`https://${label}.${config.base}/pair${suffix}`);
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

  function openPc(button, pc) {
    if (button.disabled) return;
    for (const other of $("list").children) other.disabled = true;
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    button.replaceChildren(spinner, `Opening ${pc.name}…`);
    button.setAttribute("aria-busy", "true");
    go(pc.label, "?g=1");
  }

  function showList(pcs) {
    listed = pcs;
    say("Choose a PC.");
    const list = $("list");
    list.hidden = false;
    list.replaceChildren();
    const sorted = pcs.slice().sort((a, b) => a.name.localeCompare(b.name) || a.label.localeCompare(b.label));
    for (const pc of sorted) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = pc.name;
      button.addEventListener("click", () => openPc(button, pc));
      list.append(button);
    }
  }

  function choose(pcs, pick = false) {
    if (pcs.length === 0) {
      say(EMPTY);
      return;
    }
    if (pick) {
      showList(pcs);
      return;
    }
    if (pcs.length === 1) {
      go(pcs[0].label, "?g=1");
      return;
    }
    const hit = pcs.find((pc) => pc.label === remembered());
    if (hit) {
      go(hit.label, "?g=1");
      return;
    }
    showList(pcs);
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

  function requestToken(nonce, autoSelect) {
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
        slot.hidden = false;
        slot.classList.remove("ready");
        slot.replaceChildren();
        gis.renderButton(slot, {
          type: "standard",
          theme: matchMedia("(prefers-color-scheme: dark)").matches ? "filled_black" : "outline",
          size: "large",
          text: "signin_with",
          shape: "rectangular",
          width: 300,
        });
        revealWhenDrawn(slot);
      };
      try {
        gis.cancel();
        gis.initialize({
          client_id: config.clientId,
          callback: (response) => finish(credentialFrom(response)),
          nonce,
          auto_select: autoSelect,
          // popup returns the token to the callback. A redirect would post it to a URL.
          ux_mode: "popup",
        });
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
    if (!pick && saved && await reachable(last)) {
      go(last, "?g=1");
      return;
    }
    const token = await requestToken(randomNonce(), false);
    const listed = await loadPcs(token);
    if (!listed) {
      say(OFFLINE, "error");
      return;
    }
    choose(listed, pick || saved);
  }

  async function returnLeg(pc, m) {
    // One prompt: Google stays quiet on a second auto_select within minutes and asks for the account again.
    const pcToken = await requestToken(await boundNonce(pc, m), true);
    const listed = await loadPcs(pcToken);
    if (!listed) {
      say(OFFLINE, "error");
      return;
    }
    if (!listed.some((row) => row.label === pc)) {
      say(NOT_YOURS, "error");
      return;
    }
    go(pc, `#g=${encodeURIComponent(pcToken)}`);
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
      void coldStart(params.get("pick") === "1").catch(() => say(GOOGLE_DOWN, "error"));
      return;
    }
    if (pc === null || m === null || !LABEL_RE.test(pc) || !M_RE.test(m)) {
      say(BAD_LINK, "error");
      return;
    }
    void returnLeg(pc, m).catch(() => say(GOOGLE_DOWN, "error"));
  }

  if (PHONE_RE.test(navigator.userAgent)) $("subtitle").textContent = "Reach Wink on your PC from this phone.";
  // Back from a PC restores this page from bfcache with the PC buttons still opening.
  addEventListener("pageshow", (event) => {
    if (event.persisted && !$("list").hidden) showList(listed);
  });

  const ready = googleId();
  if (ready) run(ready);
  else void whenGoogle().then(run).catch(() => say(GOOGLE_DOWN, "error"));
})();
