import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { normalizeGroupDefaultResponder, roomResponders, Store } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("room defaults", () => {
  it("creates an everyone room, persists it and lets mentions select one bot", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    store.patchBot(first.id, { name: "Ada" });
    store.patchBot(second.id, { name: "Kit" });
    const room = store.createGroup("New room", [first.id, second.id]);
    const members = [first, second];

    expect(room.defaultResponder).toEqual({ kind: "everyone" });
    expect(roomResponders("hello", members, room.defaultResponder)).toEqual(members);
    expect(roomResponders("@Kit hello", members, room.defaultResponder)).toEqual([second]);
    expect(new Store(selection).group(room.id)?.defaultResponder).toEqual({ kind: "everyone" });
  });

  it("preserves saved policies and gives an old room without a value its first member", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const lead = store.createGroup("Lead", [first.id, second.id], false, undefined, {
      defaultResponder: { kind: "member", botId: second.id },
    });
    const mentions = store.createGroup("Mentions", [first.id], false, undefined, {
      defaultResponder: { kind: "mentions" },
    });
    const legacy = store.createGroup("Legacy", [first.id, second.id]);
    const file = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    delete saved.find((room: { id: string }) => room.id === legacy.id).defaultResponder;
    writeFileSync(file, JSON.stringify(saved));

    const reloaded = new Store(selection);
    expect(reloaded.group(lead.id)?.defaultResponder).toEqual({ kind: "member", botId: second.id });
    expect(reloaded.group(mentions.id)?.defaultResponder).toEqual({ kind: "mentions" });
    expect(reloaded.group(legacy.id)?.defaultResponder).toEqual({ kind: "member", botId: first.id });
    expect(normalizeGroupDefaultResponder(undefined, [])).toEqual({ kind: "mentions" });
    expect(store.createGroup("DM", [first.id, second.id], true).defaultResponder).toEqual({ kind: "mentions" });
  });
});
