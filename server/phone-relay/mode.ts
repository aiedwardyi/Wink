// Whether the relay feature exists for this config and environment.

import { relayHost } from "../../shared/relay-host.mjs";
import { RELAY_BASE_RE, hostFor, labelFromHost } from "../../shared/relay-protocol.ts";
import type { PhoneRelayConfig } from "./index.ts";

export type RelayMode = { kind: "off" } | { kind: "invalid"; reason: string } | { kind: "on"; base: string };

export function relayMode(config: PhoneRelayConfig, env: NodeJS.ProcessEnv): RelayMode {
  const base = relayHost(config.base) ?? "";
  if (!base || config.enabled !== true || env.ORBIT_RELAY === "0") return { kind: "off" };
  return RELAY_BASE_RE.test(base) ? { kind: "on", base } : { kind: "invalid", reason: "phoneRelay.base is not a domain name" };
}

export function relayHostFor(base: string): string {
  return `relay.${base}`;
}

/** `<label>.<frontDoor>` for a PC whose relay host is on another base: the name the sign-in page sends phones to. */
export function frontDoorHost(host: string, base: string, frontDoor: string | null | undefined): string | null {
  const door = frontDoor?.trim().toLowerCase();
  const label = labelFromHost(host, base);
  return door && door !== base && label ? hostFor(label, door) : null;
}
