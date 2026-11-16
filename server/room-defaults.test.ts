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

  it.each([
    [{ kind: "member", botId: "lead" }, ["Kit"]],
    [{ kind: "mentions" }, []],
    [undefined, ["Ada", "Kit"]],
  ] as const)("keeps a saved %j pick across reloads, everyone when none was saved", (policy, answering) => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    store.patchBot(first.id, { name: "Ada" });
    store.patchBot(second.id, { name: "Kit" });
    const room = store.createGroup("Saved room", [first.id, second.id], false, undefined, {
      defaultResponder: policy?.kind === "member" ? { kind: "member", botId: second.id } : policy,
    });
    const file = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (!policy) delete saved.find((candidate: { id: string }) => candidate.id === room.id).defaultResponder;
    writeFileSync(file, JSON.stringify(saved));

    const reloaded = new Store(selection);
    const loaded = reloaded.group(room.id)!;
    const members = loaded.memberIds.map((id) => reloaded.bot(id)!);
    expect(roomResponders("hi", members, loaded.defaultResponder).map((bot) => bot.name)).toEqual(answering);
    expect(roomResponders("@Ada hi", members, loaded.defaultResponder)).toEqual([members[0]]);
    expect(new Store(selection).group(room.id)?.defaultResponder).toEqual(loaded.defaultResponder);
  });

  it("keeps bot-to-bot channels mention-only across reloads", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const dm = store.createGroup("DM", [first.id, second.id], true);

    expect(normalizeGroupDefaultResponder(undefined, [])).toEqual({ kind: "mentions" });
    expect(new Store(selection).group(dm.id)?.defaultResponder).toEqual({ kind: "mentions" });
  });
});
