import type { PhoneRelayStatus } from "../shared/relay-protocol.ts";
import { readIdentity, readTicket, ticketProblem } from "./phone-relay/store.ts";

export function teamDialMember(dataDir: string, base: string | null, owner: string | null, status: PhoneRelayStatus): boolean {
  if (!base || !owner || !/^[a-f0-9]{64}$/.test(owner) || status.state !== "connected" || status.reportOwner !== owner) return false;
  const identity = readIdentity(dataDir), ticket = readTicket(dataDir);
  return identity.kind === "ok" && ticket.kind === "ok" && !ticketProblem(ticket.value, identity.value, Date.now());
}

export function effectiveModelDial(config: { features?: { modelDial?: boolean } }, member: boolean): boolean {
  return config.features?.modelDial ?? member;
}
