import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureDirs, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { appendNative } from "./drivers/native.ts";
import { EventBus } from "./harness/bus.ts";
import * as rotatingLog from "./rotating-log.ts";

vi.mock("./rotating-log.ts", async (original) => {
  const actual = await original<typeof import("./rotating-log.ts")>();
  return { ...actual, appendRotatingLog: (file: string, text: string) => actual.appendRotatingLog(file, text, 8) };
});

beforeAll(ensureDirs);

describe("thread log caps", () => {
  it("rotates native history before writing the live message", () => {
    const file = join(NATIVE_DIR, "cap-native.ndjson");
    writeFileSync(file, "old-tail");
    appendNative("cap-native", { dir: "out", source: "test", msg: "new message" });
    expect(readFileSync(`${file}.1`, "utf8")).toBe("old-tail");
    expect(readFileSync(file, "utf8")).toContain("new message");
  });

  it("rotates event history before writing the live event", () => {
    const file = join(EVENTS_DIR, "cap-events.ndjson");
    writeFileSync(file, "old-tail");
    const bus = new EventBus();
    bus.publish({ eventId: "test", threadId: "cap-events", type: "turn.started", provider: "fake", createdAt: new Date().toISOString() } as RuntimeEvent);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("old-tail");
    expect(readFileSync(file, "utf8")).toContain("turn.started");
  });

  it.each(["bot", "room"])("deleting a %s removes live and rotated logs for every task", async (kind) => {
    const record = { id: kind, threadId: `delete-${kind}`, tasks: [{ threadId: `delete-${kind}-task` }], modelSelection: { instanceId: "fake" } };
    const threads = [record.threadId, record.tasks[0].threadId];
    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      for (const threadId of [...threads, "unrelated"]) {
        writeFileSync(join(dir, `${threadId}.ndjson`), "live");
        writeFileSync(join(dir, `${threadId}.ndjson.1`), "backup");
      }
    }
    const noop = () => {};
    const source = readFileSync(new URL(kind === "bot" ? "./index.ts" : "./group-routes.ts", import.meta.url), "utf8");
    const parsed = ts.createSourceFile("deletion.ts", source, ts.ScriptTarget.Latest, true);
    const find = (node: ts.Node): ts.Node | undefined => {
      if (kind === "bot" && ts.isFunctionDeclaration(node) && node.name?.text === "deleteBotFully") return node;
      if (kind === "room" && ts.isPropertyAssignment(node) && node.name.getText(parsed) === "remove") return node.initializer;
      return ts.forEachChild(node, find);
    };
    const declaration = find(parsed)!;
    const stop = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "stopBotWork");
    const javascript = ts.transpileModule(`${kind === "bot" ? stop!.getText(parsed) : ""}\nconst invoke = ${declaration.getText(parsed)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const deps = {
      botAccounts: { instance: () => undefined },
      registry: { get: () => undefined }, store: { groups: [], deleteBot: noop, group: () => record, deleteGroup: noop },
      limitWaits: { cancel: noop }, stopScreenPoller: noop, activeVpsThreads: new Map(), routines: { disableForBot: noop },
      lastReply: new Map(), cancelPeerApprovalsFor: noop, discardDelegationsFrom: noop, commsBus: {},
      computerControl: { forget: noop }, paneWake: { forgetBot: noop }, taskResumes: { forgetBot: noop }, accountNotices: { forget: noop },
      perBotLocalVmTarget: () => ({ key: "vm" }), localVmIdles: new Map(), groupIsWorking: () => false, json: noop,
      EVENTS_DIR, NATIVE_DIR, join, unlinkSync, ...rotatingLog,
    };
    const invoke = new Function(...Object.keys(deps), `${javascript}\nreturn invoke;`)(...Object.values(deps));
    if (kind === "bot") await invoke(record);
    else await invoke({}, ["", record.id]);
    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      for (const threadId of threads) {
        expect(existsSync(join(dir, `${threadId}.ndjson`))).toBe(false);
        expect(existsSync(join(dir, `${threadId}.ndjson.1`))).toBe(false);
      }
      expect(readFileSync(join(dir, "unrelated.ndjson.1"), "utf8")).toBe("backup");
    }
  });
});
