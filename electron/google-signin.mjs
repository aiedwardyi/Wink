// Google sign-in for Drive sync: system browser, a one-shot loopback listener
// on 127.0.0.1 and PKCE. The refresh token goes straight to credentials.bin
// through saveSession; the renderer only ever sees a status code and email.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { PAGE_CSP, signInPage } from "./google-signin-page.mjs";
import { translate } from "./i18n.mjs";

// A relay base is a bare hostname; its dashboard is served at its root.
const RELAY_BASE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FRONT_DOOR = "app.getwink.dev";
// The front door also lists PCs still on the team base from before the move (#1993); that base serves no dashboard.
const TEAM_BASES = [FRONT_DOOR, "wink.edwardyi.dev"];

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.file", "profile"];
const DRIVE_FILE = GOOGLE_SCOPES[2];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const ERROR_CODES = new Map([["access_denied", "access-denied"], ["admin_policy_enforced", "blocked"]]);
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export class GoogleSignInError extends Error {
  constructor(code) {
    super(`Google sign-in failed: ${code}`);
    this.code = code;
  }
}

/** Env first (local dev), then the file release.yml bakes into the package. `webId` is the phone sign-in client. */
export function googleClient(env, readBaked) {
  const id = env.WINK_GOOGLE_CLIENT_ID?.trim();
  const secret = env.WINK_GOOGLE_CLIENT_SECRET?.trim();
  const webId = env.WINK_GOOGLE_WEB_CLIENT_ID?.trim();
  const teamRelay = env.WINK_TEAM_RELAY?.trim();
  const teamOwner = teamOwnerHash(env.WINK_TEAM_OWNER);
  if (id && secret) return withExtras({ id, secret }, webId, teamRelay, teamOwner);
  try {
    const baked = readBaked();
    if (typeof baked?.id === "string" && baked.id && typeof baked?.secret === "string" && baked.secret) {
      return withExtras({ id: baked.id, secret: baked.secret }, baked.webId, baked.teamRelay, baked.teamOwner);
    }
  } catch {
    // No baked client: a self-built copy keeps sign-in hidden.
  }
  return null;
}

function teamOwnerHash(email) {
  const value = email?.trim().toLowerCase();
  return value ? createHash("sha256").update(value).digest("hex") : "";
}

function withExtras(client, webId, teamRelay, teamOwner) {
  if (webId) client.webId = String(webId);
  if (teamRelay) client.teamRelay = String(teamRelay);
  if (teamOwner) client.teamOwner = String(teamOwner);
  return client;
}

/** Client env for the packaged server child. The boot session is pushed, never placed here. */
export function googleServerEnv(client) {
  if (!client) return {};
  const env = { WINK_GOOGLE_CLIENT_ID: client.id, WINK_GOOGLE_CLIENT_SECRET: client.secret };
  if (client.webId) env.WINK_GOOGLE_WEB_CLIENT_ID = client.webId;
  if (client.teamRelay) env.WINK_TEAM_RELAY = client.teamRelay;
  if (client.teamOwner) env.WINK_TEAM_OWNER = client.teamOwner;
  return env;
}

/** `idToken` rides along once, from a fresh sign-in, and is never stored. */
export function createGoogleSessionPush({ isPackaged, getServerProcess, getToken, getPort, fetch = globalThis.fetch, log = () => {} }) {
  return async (stored, idToken) => {
    const session = stored && idToken ? { ...stored, idToken } : stored;
    try {
      if (isPackaged) {
        getServerProcess()?.postMessage({ type: "orbit:google-account", session });
        return;
      }
      const token = getToken();
      if (!token) return;
      const response = await fetch(`http://127.0.0.1:${getPort()}/api/internal/google-account`, {
        method: session ? "PUT" : "DELETE",
        headers: { Authorization: `Bearer ${token}`, ...(session ? { "content-type": "application/json" } : {}) },
        redirect: "error",
        ...(session ? { body: JSON.stringify(session) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      log(`google account sync failed: ${error?.message ?? error}`);
    }
  };
}

/** Dev only: a restarted dev server boots signed out, so push again whenever a new server process answers. */
export function watchDevServer({ getPort, push, fetch = globalThis.fetch, intervalMs = 5_000 }) {
  let pid = null;
  const check = async () => {
    try {
      const health = await (await fetch(`http://127.0.0.1:${getPort()}/api/health`, { signal: AbortSignal.timeout(2_000) })).json();
      if (!health?.pid || health.pid === pid) return;
      const restarted = pid !== null;
      pid = health.pid;
      if (restarted) await push();
    } catch {
      // Server down or restarting; the next tick checks again.
    }
  };
  void check();
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function googleAuthUrl({ clientId, redirectUri, challenge, state }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent select_account",
  }).toString();
  return url.toString();
}

function page(res, status, locale, title, hint, next) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP });
  res.end(signInPage({ locale, title: translate(locale, title), body: hint ? translate(locale, hint) : "", next }));
}

/** One sign-in. `onListening` sees the bound address (tests); `signal` cancels. With `hold`, the signed-in tab waits for the returned `finish(url)`. */
export async function runGoogleSignIn({ client, openExternal, fetch = globalThis.fetch, signal, timeoutMs = SIGN_IN_TIMEOUT_MS, onListening, getLocale = () => "en", hold, persist }) {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}`;
  onListening?.(address);
  let code;
  let held;
  try {
    code = await new Promise((settle, fail) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      const resolve = (value) => (done(), settle(value));
      const reject = (error) => (done(), fail(error));
      const cancel = () => reject(new GoogleSignInError("cancelled"));
      const timer = setTimeout(() => reject(new GoogleSignInError("timeout")), timeoutMs);
      if (signal?.aborted) return cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      server.on("request", (req, res) => {
        let query;
        try {
          query = new URL(req.url ?? "/", redirectUri).searchParams;
        } catch {
          return page(res, 400, getLocale(), "google.failed", "google.failedHint");
        }
        if (!query.has("code") && !query.has("error")) return page(res, 404, getLocale(), "google.failed", "google.failedHint");
        if (query.get("state") !== state) {
          page(res, 400, getLocale(), "google.failed", "google.failedHint");
          return reject(new GoogleSignInError("state-mismatch"));
        }
        if (query.has("error")) {
          page(res, 200, getLocale(), "google.notCompleted", "google.notCompletedHint");
          return reject(new GoogleSignInError(ERROR_CODES.get(query.get("error")) ?? "google-error"));
        }
        held = res;
        resolve(query.get("code"));
      });
      Promise.resolve(openExternal(googleAuthUrl({ clientId: client.id, redirectUri, challenge, state }))).catch(() =>
        reject(new GoogleSignInError("browser-failed")),
      );
    });
  } finally {
    server.close();
  }
  // The tab waits on the exchange and `persist`, so "signed in" is never shown for a sign-in that failed.
  const locale = getLocale();
  try {
    const session = await exchangeCode({ client, code, verifier, redirectUri, fetch, signal });
    await persist?.(session);
    let open = true;
    const finish = (url) => {
      if (!open) return;
      open = false;
      if (url) page(held, 200, locale, "google.signedIn", "google.openingDashboard", { url, label: translate(locale, "google.openDashboard") });
      else page(held, 200, locale, "google.signedIn", "google.signedInHint");
    };
    if (hold) return { ...session, finish };
    finish();
    return session;
  } catch (error) {
    page(held, 200, locale, "google.failed", "google.failedHint");
    throw error;
  }
}

async function exchangeCode({ client, code, verifier, redirectUri, fetch, signal }) {
  let body;
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        client_id: client.id,
        client_secret: client.secret,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    body = await response.json().catch(() => ({}));
    if (!response.ok) throw new GoogleSignInError(body?.error === "admin_policy_enforced" ? "blocked" : "exchange-failed");
  } catch (error) {
    if (signal?.aborted) throw new GoogleSignInError("cancelled");
    throw error instanceof GoogleSignInError ? error : new GoogleSignInError("offline");
  }
  if (signal?.aborted) throw new GoogleSignInError("cancelled");
  if (!String(body.scope ?? "").split(" ").includes(DRIVE_FILE)) throw new GoogleSignInError("drive-permission-missing");
  if (typeof body.refresh_token !== "string" || !body.refresh_token) throw new GoogleSignInError("exchange-failed");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(String(body.id_token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new GoogleSignInError("exchange-failed");
  }
  if (!ISSUERS.includes(claims?.iss) || claims.aud !== client.id || typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string") {
    throw new GoogleSignInError("exchange-failed");
  }
  return { refreshToken: body.refresh_token, sub: claims.sub, email: claims.email, idToken: body.id_token };
}

/** The main-process side of the preload actions. Secrets stay in here and in saveSession. */
export function createGoogleAccountController({ client, openExternal, saveSession, clearSession, fetch, getLocale, relayBase = () => null, log = () => {} }) {
  let active = null;
  // The tab of a held sign-in, waiting for the caller to say where it goes.
  let waiting = null;
  const release = (url) => {
    const finish = waiting;
    waiting = null;
    finish?.(url);
  };
  let transition = Promise.resolve();
  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(() => {}, () => {});
    return next;
  };
  return {
    async signIn({ hold } = {}) {
      if (!client) return { ok: false, error: "unavailable" };
      active?.abort();
      release();
      const controller = new AbortController();
      active = controller;
      try {
        const persist = ({ idToken, ...stored }) =>
          serialize(async () => {
            if (controller.signal.aborted) throw new GoogleSignInError("cancelled");
            await saveSession(stored, idToken);
          });
        const { email, finish } = await runGoogleSignIn({ client, openExternal, fetch, getLocale, hold: hold === true, signal: controller.signal, persist });
        if (controller.signal.aborted) {
          finish?.();
          return { ok: false, error: "cancelled" };
        }
        waiting = finish ?? null;
        return { ok: true, email };
      } catch (error) {
        const code = error instanceof GoogleSignInError ? error.code : "store-failed";
        log(`google sign-in failed: ${code}`);
        return { ok: false, error: code };
      } finally {
        if (active === controller) active = null;
      }
    },
    // Only a known dashboard: the front door for a team base, else this PC's own saved relay.
    finish(base) {
      const saved = relayBase();
      const host = TEAM_BASES.includes(base) ? FRONT_DOOR : base === saved && RELAY_BASE.test(saved ?? "") ? saved : null;
      release(host ? `https://${host}/` : undefined);
    },
    cancel() {
      active?.abort();
      release();
    },
    async signOut() {
      active?.abort();
      release();
      await serialize(clearSession);
      return { ok: true };
    },
  };
}
