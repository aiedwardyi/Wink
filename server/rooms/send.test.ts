import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_PENDING_MS } from "../../shared/bot-chain.ts";
import { DATA_DIR } from "../config.ts";
import { Store } from "../store.ts";
import { closeAsksDb, configureRoomAsks, roomAsks, type HostedGroup, type RoomAskDeps } from "./asks.ts";
import { addPerson, appendRoomEntry, closeRoomsDb, createRoom, PERSON_TEXT_MAX, ROOM_TEXT_MAX, type RoomPerson } from "./db.ts";
import { copyRoomFile } from "./files.ts";
import { createPeopleOnlyRoom } from "./people-only.ts";
import { hostedSend, hostSend, liveBotChain, stopBotChain, teamBotSend } from "./send.ts";
import { addTeamBot, type TeamBot } from "./team-bots.ts";

let store: Store;
let group: HostedGroup;
let wink: string;
let people: Record<"mina" | "minjun" | "jun" | "sora", RoomPerson>;
let deps: RoomAskDeps;

const person = (who: keyof typeof people) => ({ kind: "person" as const, id: people[who].id });

beforeEach(() => {
  closeRoomsDb();
  closeAsksDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  wink = store.patchBot(store.createBot().id, { name: "Wink" })!.id;
  const helper = store.patchBot(store.createBot().id, { name: "위키" })!.id;
  group = store.createGroup("Team", [wink, helper], false, undefined, undefined, { roomId: createRoom("Team").id }) as HostedGroup;
  const taken = ["Wink", "위키"];
  people = {
    mina: addPerson(group.hosted.roomId, "Mina", taken),
    minjun: addPerson(group.hosted.roomId, "민준", taken),
    jun: addPerson(group.hosted.roomId, "Jun", taken),
    sora: addPerson(group.hosted.roomId, "Sora", taken),
  };
  deps = {
    store,
    hostName: () => "Edward",
    instance: () => null,
    dispatch: vi.fn(),
    stopTurn: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
  };
  configureRoomAsks(deps);
});
afterEach(() => {
  configureRoomAsks(null);
  closeAsksDb();
  closeRoomsDb();
});

describe("hostedSend", () => {
  it("posts plain lines with no ask and no call, and marks the room unread for people only", () => {
    const sent = hostedSend(group, person("sora"), "lunch at noon?");
    expect(sent.ask).toBeNull();
    expect(sent.message).toMatchObject({ role: "user", origin: "person", text: "lunch at noon?" });
    expect(store.group(group.id)!.unread).toBe(true);
    store.patchGroup(group.id, { unread: false });
    hostedSend(group, { kind: "host" }, "sure");
    expect(store.group(group.id)!.unread).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("wakes nobody on @everyone or a person's name", () => {
    expect(hostedSend(group, { kind: "host" }, "@everyone standup in 5").ask).toBeNull();
    expect(hostedSend(group, { kind: "host" }, "@민준 can you check").ask).toBeNull();
    expect(roomAsks(group.hosted.roomId, ["held", "queued"])).toEqual([]);
  });

  it("routes a Korean bot name and a reply to a bot", () => {
    const korean = hostedSend(group, person("mina"), "@위키 정리해 줘").ask!;
    expect(store.bot(korean.botId)!.name).toBe("위키");
    const answer = appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: korean.botId, name: "위키" }, text: "done", replyToId: korean.entryId });
    expect(hostedSend(group, person("minjun"), "and the rest?", answer.id).ask).toMatchObject({ botId: korean.botId, quoteId: answer.id });
  });

  it("does not wake the host's reply target for an explicit teammate bot tag", () => {
    addTeamBot(group.hosted.roomId, people.sora.id, "스타줌", "teal", []);
    const answer = appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: wink, name: "Wink" }, text: "handoff" });
    expect(hostedSend(group, person("sora"), "@스타줌 이거해.", answer.id).ask).toBeNull();
    store.patchGroup(group.id, { memberIds: [wink] });
    expect(hostedSend(store.group(group.id) as HostedGroup, person("sora"), "@스타줌 이거해.", answer.id).ask).toBeNull();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(hostedSend(group, person("sora"), "@Mina can you check?", answer.id).ask).toMatchObject({ botId: wink });
    expect(hostedSend(group, person("sora"), "thanks", answer.id).ask).toMatchObject({ botId: wink });
  });

  it("gives two people two asks", () => {
    const first = hostedSend(group, person("mina"), "@Wink fix the build").ask!;
    const second = hostedSend(group, person("minjun"), "@Wink fix the build").ask!;
    expect(first.id).not.toBe(second.id);
    expect([first.state, second.state]).toEqual(["queued", "queued"]);
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
  });

  it("runs every teammate's @ as clean work, like the host's", () => {
    expect(hostedSend(group, person("mina"), "@Wink a").ask).toMatchObject({ grant: "work", state: "queued", clean: true });
    expect(hostedSend(group, person("jun"), "@Wink b").ask).toMatchObject({ grant: "work", state: "queued", clean: true });
    expect(hostedSend(group, person("sora"), "@Wink c").ask).toMatchObject({ grant: "work", state: "queued", clean: true });
    expect(deps.dispatch).toHaveBeenCalledTimes(3);
  });

  it("leaves the host's own @ to the group turn", () => {
    expect(hostedSend(group, { kind: "host" }, "@Wink hi").ask).toBeNull();
    expect(roomAsks(group.hosted.roomId, ["held", "queued", "running"])).toEqual([]);
  });

  it("marks an ask unclean only when it quotes an unclean bot answer", () => {
    const quote = hostedSend(group, person("jun"), "the spec is in /docs").entry;
    expect(hostedSend(group, person("mina"), "@Wink see this", quote.id).ask).toMatchObject({ clean: true, quoteId: quote.id });
    const echoed = appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: wink, name: "Wink" }, text: "echo", clean: false });
    expect(hostedSend(group, person("minjun"), "@Wink and this", echoed.id).ask).toMatchObject({ clean: false });
  });

  it("keeps the host's sendId on the mirrored message", () => {
    const { message } = hostedSend(group, { kind: "host" }, "@Wink hi", undefined, "send-0000000001");
    expect(message.sendId).toBe("send-0000000001");
    expect(store.messagesFor(group.threadId).find((row) => row.id === message.id)?.sendId).toBe("send-0000000001");
  });

  it("routes only on the committed text", () => {
    const sent = hostedSend(group, person("mina"), `${"a".repeat(PERSON_TEXT_MAX)} @Wink do the work`);
    expect(sent.entry.text).toBe("a".repeat(PERSON_TEXT_MAX));
    expect(sent.ask).toBeNull();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the host's full text on the thread row and caps a tag-free copy for the room", () => {
    const text = `see <attached-image path="C:\\a.png" />\n<attached-file path="C:\\b.log" name="b.log" size="9" />\n${"x".repeat(ROOM_TEXT_MAX)}`;
    const { entry, message } = hostSend(group, text);
    expect(message.text).toBe(text);
    expect(entry.text).toMatch(/^see \[image\]\n\[file: b\.log\]\nx+$/);
    expect(entry.text).toHaveLength(ROOM_TEXT_MAX);
    expect(hostSend(group, '<attached-image path="C:\\a.png" />').entry.text).toBe("[image]");
  });

  it("keeps the host's reply to a row the room log never got as a local reply", () => {
    const bot = { botId: wink, name: "Wink", color: "" };
    const unlinked = store.appendMessage(group.threadId, { role: "bot", kind: "text", text: "part one", from: bot });
    const sent = hostSend(group, "this bit?", unlinked);
    expect(sent.entry.replyToId).toBeUndefined();
    expect(sent.message.replyToId).toBe(unlinked.id);
    const linked = hostSend(group, "and this", sent.message);
    expect(linked.entry.replyToId).toBe(sent.entry.id);
    expect(linked.message.replyToId).toBe(sent.message.id);
  });

  it("refuses someone who isn't in the room", () => {
    expect(() => hostedSend(group, { kind: "person", id: "stranger" }, "hi")).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("never wakes the only bot for a reply to a teammate's own bot", () => {
    const solo = store.createGroup("Solo", [wink], false, undefined, undefined, { roomId: createRoom("Solo").id }) as HostedGroup;
    const mina = addPerson(solo.hosted.roomId, "Mina", ["Wink"]);
    const pete = appendRoomEntry(solo.hosted.roomId, { author: { kind: "bot", id: "tb-AAAAAAAAAAAAAAAA", name: "Pete-Coder", owner: mina.id }, text: "chart's ready" });
    expect(hostedSend(solo, { kind: "person", id: mina.id }, "thanks, now the totals", pete.id).ask).toBeNull();
    expect(hostedSend(solo, { kind: "person", id: mina.id }, "lunch?").ask).toMatchObject({ botId: wink });
  });
});

describe("teamBotSend", () => {
  let star: TeamBot;
  const asks = () => roomAsks(group.hosted.roomId, ["held", "queued", "running"]);
  const said = (text: string, replyToId?: string) => teamBotSend(group, people.sora, star, text, replyToId);
  const winkLine = (text: string) => appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: wink, name: "Wink" }, text });
  beforeEach(() => {
    star = addTeamBot(group.hosted.roomId, people.sora.id, "스타줌", "teal", ["Wink", "위키"]);
  });

  it("wakes the host bot it @'s with one ask under its owner", () => {
    const entry = said("@Wink Sora is free after 7. What works for Edward?");
    expect(asks()).toEqual([expect.objectContaining({ botId: wink, asker: { kind: "person", id: people.sora.id }, entryId: entry.id, grant: "work", state: "queued", clean: true })]);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it("starts no turn from a picture's caption", async () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const path = join(DATA_DIR, "chart.png");
    writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]));
    const file = await copyRoomFile(path, group.hosted.roomId, { owner: people.sora.id, name: "chart.png", uploadId: "picture-0123456789abcdef" });
    const entry = teamBotSend(group, people.sora, star, "Chart from @Wink", undefined, undefined, [file.id]);
    expect(entry.files).toEqual([file]);
    expect(asks()).toEqual([]);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("wakes nobody without an explicit @ to a host bot", () => {
    const answer = winkLine("7:30 works?");
    said("Done: Sat 7:30. @Edward @Sora", answer.id);
    said("thanks", answer.id);
    said("@스타줌 note to self");
    expect(asks()).toEqual([]);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("waits behind its owner's open request", () => {
    hostedSend(group, person("sora"), "@위키 first");
    said("@Wink next");
    expect(asks().map((ask) => ask.botId)).toHaveLength(2);
  });

  it("ends the chain on a line that tags no bot", () => {
    said("@Wink your turn");
    winkLine("@스타줌 7:30 works?");
    said("Done: Sat 7:30. @Edward @Sora");
    expect(asks()).toHaveLength(1);
  });

  it("goes on past many bot lines until Stop, then waits for a person", () => {
    for (let n = 0; n < 20; n++) winkLine(`@스타줌 turn ${n}`);
    said("@Wink still going");
    expect(asks()).toHaveLength(1);
    stopBotChain(group.hosted.roomId);
    said("@Wink one more");
    expect(asks()).toHaveLength(1);
    hostedSend(group, person("mina"), "keep going");
    said("@Wink again");
    expect(asks()).toHaveLength(2);
  });

  it("counts the live handoff until a line tags no bot, Stop, or a person speaks", () => {
    expect(liveBotChain(group)).toBe(0);
    hostedSend(group, person("sora"), "@Wink work with 스타줌");
    winkLine("@스타줌 Edward is free after 6");
    said("@Wink Sora is free after 7");
    expect(liveBotChain(group)).toBe(2);
    said("Done: Sat 7:30. @Edward @Sora");
    expect(liveBotChain(group)).toBe(0);
    said("@Wink one more thing");
    expect(liveBotChain(group)).toBe(4);
    stopBotChain(group.hosted.roomId);
    expect(liveBotChain(group)).toBe(0);
    winkLine("@스타줌 still here");
    expect(liveBotChain(group)).toBe(0);
    hostSend(group, "go on");
    winkLine("@스타줌 back to it");
    expect(liveBotChain(group)).toBe(1);
  });

  it("counts a handoff between teammates' bots in a people-only room", () => {
    const crew = store.createGroup("Crew", [], false, undefined, undefined, { roomId: createPeopleOnlyRoom("Crew").id }) as HostedGroup;
    const jj = addPerson(crew.hosted.roomId, "JJ", []);
    const mina = addPerson(crew.hosted.roomId, "Mina", []);
    const pete = addTeamBot(crew.hosted.roomId, jj.id, "Pete", "teal", []);
    const zoe = addTeamBot(crew.hosted.roomId, mina.id, "Zoe", "teal", ["Pete"]);
    teamBotSend(crew, jj, pete, "@Zoe your turn");
    teamBotSend(crew, mina, zoe, "@Pete back to you");
    expect(liveBotChain(crew)).toBe(2);
    const changed = vi.fn();
    store.onChange(changed);
    hostedSend(crew, { kind: "host" }, "I'll take it from here");
    expect(liveBotChain(crew)).toBe(0);
    expect(changed).toHaveBeenCalledWith({ type: "group", groupId: crew.id });
  });

  it("shows no strip for a handoff in a people-only room", () => {
    const crew = store.createGroup("Crew", [wink], false, undefined, undefined, { roomId: createPeopleOnlyRoom("Crew").id }) as HostedGroup;
    const sora = addPerson(crew.hosted.roomId, "Sora", ["Wink"]);
    teamBotSend(crew, sora, addTeamBot(crew.hosted.roomId, sora.id, "Pete", "teal", ["Wink"]), "@Wink your turn");
    expect(liveBotChain(crew)).toBe(0);
  });

  it("counts a host bot's handoff while the bot it tagged works, however old", () => {
    appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: wink, name: "Wink" }, text: "@위키 your turn" }, Date.now() - 10 * 60_000);
    expect(liveBotChain(group)).toBe(0);
    expect(liveBotChain({ ...group, busyBotId: group.memberIds[1]! })).toBe(1);
  });

  it("drops a handoff to a teammate's bot once it's no longer pending, and republishes then", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      winkLine("@스타줌 your turn");
      expect(liveBotChain(group)).toBe(1);
      const changed = vi.fn();
      store.onChange(changed);
      vi.advanceTimersByTime(CHAIN_PENDING_MS);
      expect(changed).toHaveBeenCalledWith({ type: "group", groupId: group.id });
      expect(liveBotChain(group)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a stopped handoff hidden after a restart", async () => {
    appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: wink, name: "Wink" }, text: "@스타줌 your turn" }, Date.now() - 1000);
    stopBotChain(group.hosted.roomId);
    expect(liveBotChain(group)).toBe(0);
    vi.resetModules();
    const [restarted, restartedAsks, restartedDb] = await Promise.all([import("./send.ts"), import("./asks.ts"), import("./db.ts")]);
    restartedAsks.configureRoomAsks(deps);
    try {
      expect(restarted.liveBotChain(group)).toBe(0);
    } finally {
      restartedAsks.configureRoomAsks(null);
      restartedAsks.closeAsksDb();
      restartedDb.closeRoomsDb();
    }
  });

  it("still posts but wakes nobody in a people-only room", () => {
    const crew = store.createGroup("Crew", [], false, undefined, undefined, { roomId: createPeopleOnlyRoom("Crew").id }) as HostedGroup;
    const sora = addPerson(crew.hosted.roomId, "Sora", []);
    const pete = addTeamBot(crew.hosted.roomId, sora.id, "Pete", "teal", []);
    teamBotSend(crew, sora, pete, "@Wink hi");
    expect(roomAsks(crew.hosted.roomId, ["held", "queued", "running"])).toEqual([]);
  });
});

describe("room alerts on the host", () => {
  const alert = vi.fn();
  const line = (name: string, text: string) => [{ chat: group.id, threadId: group.threadId, room: "Team", name, text }];
  beforeEach(() => {
    vi.useFakeTimers();
    alert.mockReset();
    configureRoomAsks({ ...deps, alert });
  });
  afterEach(() => vi.useRealTimers());

  it("pings 3 s after a teammate's line while the room is still unread", () => {
    hostedSend(group, person("sora"), "hi");
    vi.advanceTimersByTime(2_999);
    expect(alert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(alert.mock.calls).toEqual([line("Sora", "hi")]);
  });

  it("sends one ping with the latest line for lines inside one wait", () => {
    hostedSend(group, person("sora"), "first");
    vi.advanceTimersByTime(1_000);
    hostedSend(group, person("mina"), "second");
    vi.advanceTimersByTime(3_000);
    expect(alert.mock.calls).toEqual([line("Mina", "second")]);
  });

  it("never pings the host's own line", () => {
    hostedSend(group, { kind: "host" }, "sure");
    store.patchGroup(group.id, { unread: true });
    hostedSend(group, person("mina"), "민준 here");
    vi.advanceTimersByTime(3_000);
    expect(alert.mock.calls).toEqual([line("Mina", "민준 here")]);
  });

  it("stays quiet for a teammate's bot handing off and pings its closing line", () => {
    const star = addTeamBot(group.hosted.roomId, people.sora.id, "스타줌", "teal", ["Wink", "위키"]);
    teamBotSend(group, people.sora, star, "@Wink your turn");
    vi.advanceTimersByTime(3_000);
    expect(alert).not.toHaveBeenCalled();
    teamBotSend(group, people.sora, star, "Done: Sat 7:30. @Edward @Sora");
    vi.advanceTimersByTime(3_000);
    expect(alert.mock.calls).toEqual([line("스타줌", "Done: Sat 7:30. @Edward @Sora")]);
  });

  it("stays quiet when the room is read on screen within the wait", () => {
    hostedSend(group, person("sora"), "first");
    store.patchGroup(group.id, { unread: false });
    vi.advanceTimersByTime(3_000);
    hostedSend(group, person("sora"), "second");
    vi.advanceTimersByTime(3_000);
    expect(alert.mock.calls).toEqual([line("Sora", "second")]);
  });
});
