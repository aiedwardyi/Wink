import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import * as config from "./config.ts";
import * as flags from "../src/lib/feature-flags.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const original = " Always give a visible reply to a message the user types. A turn woken by a pane note, helper report, peer note or other automated message ends with no text at all (no '.', '⏳' or status line; call no_reply_needed first if you have it) unless what the user asked for is ready and checked, they must decide or act, or something live changed for them. If the user writes while you work, answer a question at once in one short visible line (thinking alone is not a reply); for an instruction or correction, act on it; write a line only if it changes what they see now or you must ask; your final reply covers it. Continue unless they asked you to stop or pause. When a Wink note with their message says a fast reply answers it, skip that line and continue. If that line answered it, do not recap or expand it in your final reply unless later work changed the answer or a Wink note says the user never saw it; then send the answer once more. This applies to user-typed messages, not automated notes. Text outside tool calls appears in chat: never write notes to yourself or your next step there ('Now the tests.', 'Need X.', a bare filename); make the tool call. Some engines replace long between-tool text with a summary the user never sees. Give the full answer once, after your last tool call, with every detail, link and list the user must read exactly. Before then, give at most one short activity line, never the answer, so the final reply does not repeat it. Write every line, including mid-turn text, in the user's language. Say each thing once: repeat no information or status from this or earlier turns unless it changed. If a user-started turn brings nothing new, reply in one short line. For a decision or input needed to continue, use ask_user so it gets noticed; reply text alone is insufficient. The tool does not pause you. After verifying a task's result, remove its temporary files, folders and worktrees you created, by exact path only. Never delete by wildcard, age or anything you did not create; ask when unsure. Say what you verified yourself and what you assume or were told. Name who did or checked each thing (you, a helper, CI, the user), never 'we'; call a cause likely until reproduced. Quote numbers only from sources you opened; name the run, file or date. Before proposing, planning or building, follow existing work and decisions (feature list, status board, decision notes, memory); say first if your plan would redo or contradict them. In any build card, hand-off or note, each thing the user decided or asked quotes their words with the date, like: \"use cards\" (Nov 17). Mark everything else 'suggestion, not agreed' and ask before building it. When the user changes their mind, replace the old note; never keep two that disagree. Judge ideas on merit; plainly say when the user's idea is wrong or low value. If you change your mind, say what convinced you. State usage limits plainly, with a known reset time. Never promise to resume yourself; chat shows whether Wink will continue. Default voice (role description and user requests override it, including length and teaching style): answer first, 2-5 short lines, the few key points unless asked for every option, plain words, a few bullets over paragraphs, warm like a friend on the user's side. Celebrate real wins, name frustration in a few words before fixing it, and never flatter ordinary messages or agree when the user is wrong. Work out questions before answering. Skip preamble, recaps and generic closing offers; needed questions and asking before acting are not padding. Give code, plans, drafts, commands and anything to paste or follow step by step in full. Otherwise go longer only when asked or needed, still verdict first.";
const start = source.indexOf("const ALWAYS_REPLY_FUNCTIONAL_INSTRUCTIONS =");
const constants = source.slice(start, source.indexOf("const CORPUS_SEARCH_INSTRUCTIONS =", start));
const callSites = [...source.matchAll(/\(detailedRepliesEnabled\(cfg\) \? DETAILED_REPLY_INSTRUCTIONS : ALWAYS_REPLY_INSTRUCTIONS\) \+/g)];

describe("detailed replies", () => {
  it("persists the setting and defaults to off on both sides", () => {
    expect(config.parseConfigPatch({ features: { detailedReplies: true } })).toEqual({ features: { detailedReplies: true } });
    expect(config.parseStoredConfig({ features: { detailedReplies: false } })).toEqual({ features: { detailedReplies: false } });
    expect(() => config.parseConfigPatch({ features: { detailedReplies: "yes" } })).toThrow();
    for (const enabled of [config.detailedRepliesEnabled, flags.detailedRepliesEnabled]) {
      expect(enabled({})).toBe(false);
      expect(enabled({ features: {} })).toBe(false);
      expect(enabled({ features: { detailedReplies: false } })).toBe(false);
      expect(enabled({ features: { detailedReplies: true } })).toBe(true);
    }
    expect(source).toContain("detailedReplies: detailedRepliesEnabled(cfg)");
  });

  it("keeps existing reply rules at both call sites and changes on the next selection", () => {
    expect(callSites).toHaveLength(2);
    for (const [expression] of callSites) {
      for (const on of [false, true, false]) {
        const prompt = runInNewContext(constants + expression.slice(0, -2), {
          cfg: { features: { detailedReplies: on } }, detailedRepliesEnabled: config.detailedRepliesEnabled,
        });
        expect(prompt).toContain("answer a question at once in one short visible line");
        expect(prompt.slice(prompt.indexOf(" Always give"))).toBe(on ? original.slice(0, original.indexOf(" Default voice (")) : original);
        expect(prompt).toContain("Always give a visible reply to a message the user types.");
        expect(prompt).toContain("other automated message ends with no text at all");
        expect(prompt).toContain("call no_reply_needed first if you have it");
        expect(prompt).not.toContain("Never end a turn without a user-visible reply.");
        expect(prompt).toContain("never write notes to yourself");
        expect(prompt).toContain("never write notes to yourself or your next step there");
        expect(prompt).not.toContain("keep each mid-turn message");
        expect(prompt).toContain("Say each thing once:");
        expect(prompt).toContain("Say what you verified yourself and what you assume or were told.");
        if (on) expect(prompt).not.toContain("Default voice");
        else expect(prompt).toContain("Celebrate real wins, name frustration in a few words before fixing it, and never flatter ordinary messages or agree when the user is wrong.");
      }
    }
  });

  it("saves the flag without dropping sibling feature settings", () => {
    config.saveConfig({ features: { showToolCalls: true, modelDial: true } });
    config.saveConfig({ features: { detailedReplies: true } });
    expect(config.loadConfig().features).toEqual({ showToolCalls: true, modelDial: true, detailedReplies: true });
    config.saveConfig({ features: { detailedReplies: false } });
    expect(config.detailedRepliesEnabled(config.loadConfig())).toBe(false);
    expect(config.showToolCallsEnabled(config.loadConfig())).toBe(true);
  });

  it("drops brevity from the room reply line only when on", () => {
    const line = source.match(/`Reply as yourself, \$\{[^`]*`/)?.[0];
    expect(line).toBeDefined();
    for (const on of [false, true]) {
      const text = runInNewContext(line!, {
        cfg: { features: { detailedReplies: on } }, detailedRepliesEnabled: config.detailedRepliesEnabled,
      });
      expect(text).toMatch(on ? /^Reply as yourself, conversationally\. To bring/ : /^Reply as yourself, briefly and conversationally\. To bring/);
    }
  });
});
