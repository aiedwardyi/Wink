import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PHONE_RELAY_OFF, signTicket, type PhoneRelayStatus } from "../shared/relay-protocol.ts";
import { modelDialEnabled } from "../src/lib/feature-flags.ts";
import { loadConfig, parseConfigPatch, saveConfig } from "./config.ts";
import { effectiveModelDial, teamDialMember } from "./model-dial-default.ts";
import { loadOrCreateIdentity, writeTicket } from "./phone-relay/store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const owner = "a".repeat(64);
const connected: PhoneRelayStatus = { ...PHONE_RELAY_OFF, state: "connected", reportOwner: owner };
const dirs: string[] = [];

function enrolled(expires = Math.floor(Date.now() / 1000) + 3600) {
  const dir = mkdtempSync(join(tmpdir(), "dial-team-"));
  dirs.push(dir);
  const identity = loadOrCreateIdentity(dir);
  writeTicket(dir, signTicket({ label: identity.label, pk: identity.pk, iat: Math.floor(Date.now() / 1000) - 60, exp: expires }, generateKeyPairSync("ed25519").privateKey));
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

describe("team model dial default", () => {
  it("enables the renderer for an authenticated enrolled team member without a setting", () => {
    const member = teamDialMember(enrolled(), "team.example", owner, connected);
    expect(member).toBe(true);
    expect(modelDialEnabled({ features: { modelDial: effectiveModelDial({}, member) } })).toBe(true);
  });

  it("keeps a teammate's explicit off through later config saves and reloads", () => {
    const member = teamDialMember(enrolled(), "team.example", owner, connected);
    saveConfig(parseConfigPatch({ features: { modelDial: false } }));
    saveConfig(parseConfigPatch({ features: { showToolCalls: true } }));
    expect(effectiveModelDial(loadConfig(), member)).toBe(false);
    expect(modelDialEnabled({ features: { modelDial: effectiveModelDial(loadConfig(), member) } })).toBe(false);
  });

  it("keeps non-members off by default and preserves their explicit opt-in", () => {
    expect(effectiveModelDial({}, false)).toBe(false);
    expect(effectiveModelDial({ features: {} }, false)).toBe(false);
    expect(effectiveModelDial({ features: { modelDial: true } }, false)).toBe(true);
  });

  it("requires the configured owner, authenticated ready and a valid local enrollment", () => {
    const dir = enrolled();
    expect(teamDialMember(dir, null, owner, connected)).toBe(false);
    expect(teamDialMember(dir, "team.example", null, connected)).toBe(false);
    expect(teamDialMember(dir, "team.example", "bad", connected)).toBe(false);
    expect(teamDialMember(dir, "team.example", "b".repeat(64), connected)).toBe(false);
    expect(teamDialMember(dir, "team.example", owner, { ...connected, reportOwner: undefined })).toBe(false);
    expect(teamDialMember(dir, "team.example", owner, { ...connected, state: "rejected" })).toBe(false);
    expect(teamDialMember(enrolled(1), "team.example", owner, connected)).toBe(false);
    expect(teamDialMember(join(dir, "missing"), "team.example", owner, connected)).toBe(false);
    const other = enrolled();
    writeTicket(other, JSON.parse(readFileSync(join(dir, "phone-relay", "ticket.json"), "utf8")).ticket);
    expect(teamDialMember(other, "team.example", owner, connected)).toBe(false);
  });

  it("publishes the effective value through config and refreshes it on relay changes", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("modelDial: effectiveModelDial(cfg, teamDialMember(DATA_DIR, phoneAccess.base(), googleEnv.teamOwner, phoneAccess.status()))");
    expect(source).toMatch(/if \(dial !== relayModelDial\) \{\s+relayModelDial = dial;\s+broadcast\(\{ kind: "config", \.\.\.configStatus\(\) \}\);/);
  });
});
