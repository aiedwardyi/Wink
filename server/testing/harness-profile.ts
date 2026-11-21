import { once } from "node:events";
import { attachHarnessTestHome } from "../../companion/src/test-profile.ts";

if (!process.connected || !process.send) throw new Error("Vitest child requires its test-profile connection");

const waiter = new AbortController();
const response = Promise.race([
  once(process, "message", { signal: waiter.signal }).then(([profile]) => profile),
  once(process, "disconnect", { signal: waiter.signal }).then(() => undefined),
]);
process.send("wink:test-profile");
const profile = await response.finally(() => waiter.abort());
if (!profile || typeof profile.home !== "string" || typeof profile.canonical !== "string" || typeof profile.nonce !== "string") {
  throw new Error("Vitest child did not receive a verified test home");
}
attachHarnessTestHome(profile);
