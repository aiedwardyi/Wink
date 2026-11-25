import { isPhone } from "./phone-swipe";
import { remotePhoneSetup, type RemotePhoneLink } from "./phone-setup";

/** Relay management answers only on this PC; a phone, browser or device window is elsewhere. */
export const onThisPc = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/** An engine sign-in opens its browser on the PC: a phone, or a browser or PC window on another computer, never sees it. */
// A server render has no location, and renders as this PC.
export const signsInElsewhere = () => !window.ogb && (isPhone() || (globalThis.location !== undefined && !onThisPc()));

/** How this window signs an engine in, for Sign In and Add Account alike: the code flow when the CLI's browser would open out of reach, or when the engine has only that flow (Muse). */
export function engineSignInFlow(login: { args: string[]; deviceArgs?: string[]; deviceEnv?: Record<string, string> } | undefined, adding = false) {
  const elsewhere = signsInElsewhere();
  const deviceOnly = Boolean(login?.deviceArgs && login.deviceArgs.join("\0") === login.args.join("\0"));
  // An added account keeps the code flow in any browser, except where its browser login opens nothing on the PC (deviceEnv: Claude, Gemini).
  const device = Boolean(login?.deviceArgs) && (adding ? !window.ogb && (!login?.deviceEnv || elsewhere) : elsewhere);
  return { device, computerOnly: elsewhere && !login?.deviceArgs, deviceFlow: elsewhere || deviceOnly };
}

/** The sign-in site a relay browser signs out to; null in the desktop app and its PC windows, on the tailnet and on this PC. */
export function relaySignInSite(): string | null {
  const pc = /^[a-z2-7]{16}\.(.+)$/.exec(location.hostname);
  return window.ogb || /\bElectron\//.test(navigator.userAgent) || location.hostname.endsWith(".ts.net") || !pc ? null : `https://${pc[1]}`;
}

export function devicesSetup(status: RemotePhoneLink | null, loginOpened = false) {
  const setup = remotePhoneSetup(status);
  const backend = status?.setup?.backendState;
  const installed = !["missing", "checking", "disabled"].includes(setup.state);
  const signedIn = backend === "Running" || setup.running;
  const ready = setup.state === "ready" && Boolean(setup.url);
  const phoneOpened = Boolean(status?.phones?.length);
  return {
    ...setup, installed, signedIn, ready,
    account: status?.setup?.account,
    canSignIn: backend === "NeedsLogin" && !status?.setup?.haveNodeKey && !loginOpened,
    loginOpened: backend === "NeedsLogin" && loginOpened,
    needsApproval: backend === "NeedsMachineAuth",
    phoneJoined: phoneOpened || Boolean(status?.setup?.phoneJoined),
    phoneOpened,
    pcOnline: Boolean(status?.pcs?.length),
  };
}
