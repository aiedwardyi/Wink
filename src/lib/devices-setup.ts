import { remotePhoneSetup, type RemotePhoneLink } from "./phone-setup";

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
