import { remotePhoneSetup, type RemotePhoneLink } from "./phone-setup";

/** Relay management answers only on this PC; a phone, browser or device window is elsewhere. */
export const onThisPc = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

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
