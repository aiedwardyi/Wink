import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import type { ForumPrediction } from "../shared/forum-lesson.ts";
import type { VerifyResult } from "../shared/live-verify.ts";
import { projectIdOf, type Board, type BoardPost } from "./board.ts";
import { predictionSchema } from "./forum-lesson-schema.ts";
import { redactSecretsInText } from "./redact.ts";

type Source = { botId: string; threadId: string; project: string; model: string };
type Request = { botId: string; project?: string | null; model: string; text: string; room: boolean };
type Evidence = { runId: string; page: string; entry?: string; revision: string; checks: NonNullable<VerifyResult["checks"]> };
type LessonPost = BoardPost & { lesson: NonNullable<BoardPost["lesson"]> };

const NAV = "NAV/phone";
const MAX_BEFORE = 64;
const BEFORE_MS = 30 * 60_000;
const HANDOFF_BYTES = 112;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const folderKey = (folder: string) => {
  const path = normalize(folder).replace(/[\\/]+$/, "");
  return hash(process.platform === "win32" ? path.toLowerCase() : path);
};
const phoneRequest = /\b(?:fix|repair|restore)\s+(?:(?:the|a|broken|missing)\s+){0,3}(?:(?:phone|mobile)\s+(?:menu|navigation)|hamburger(?:\s+menu)?)\b|\b(?:(?:phone|mobile)\s+(?:menu|navigation)|hamburger(?:\s+menu)?)\s+(?:(?:is\s+)?(?:broken|missing|not working)|(?:doesn.t|won.t)\s+open)\b/i;
const negation = /\b(?:do not|don.t|never|avoid)\s+(?:fix|repair|restore)\b/i;
const pageExpression = (page: string) => new RegExp(`(?:^|[\\s"'\`(])${page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"'\`),.!?])`, "i");
const sourceRef = (changeId: string) => `verify-lesson:${changeId}`;
const isLesson = (post: BoardPost): post is LessonPost => Boolean(post.lesson);

export function lessonRequest(value: string): { entry: string; prediction?: ForumPrediction; invalid?: true } {
  const split = value.indexOf("\n");
  if (split < 0) return { entry: value.trim() };
  const entry = value.slice(0, split).trim();
  if (value.length <= 4096) {
    try {
      const parsed = predictionSchema.safeParse(JSON.parse(value.slice(split + 1)));
      if (parsed.success) return { entry, prediction: parsed.data };
    } catch {}
  }
  return { entry, invalid: true };
}

export function createForumLessons(board: Board, pcId: () => string, enabled = true) {
  const before = new Map<string, { source: Source; evidence: Evidence; at: number }>();
  const reserved = new Set<string>();
  const attempts = new Map<string, Evidence>();
  let local: LessonPost[] = [];
  let prepared = new Map<string, Array<{ post: LessonPost; page: RegExp; text: string; delivered: Set<string> }>>();
  const refresh = () => {
    local = board.list().filter(isLesson).filter(post => post.lesson.originPc === pcId() && !post.lesson.superseded);
    const index: typeof prepared = new Map();
    if (enabled) for (const post of local) {
      const { lesson } = post;
      if (lesson.outcome !== "fixed" || lesson.check !== NAV || /^https?:\/\//i.test(lesson.page)) continue;
      const rows = index.get(lesson.projectKey) ?? [];
      if (rows.length >= 24) continue;
      const summary = lesson.change.replace(/[^a-zA-Z0-9 .,()/+-]/g, " ").replace(/\s+/g, " ").trim();
      const prefix = `Forum ${post.id}: phone menu check passed. Fix: `;
      rows.push({
        post,
        page: pageExpression(lesson.page),
        text: (prefix + summary.slice(0, HANDOFF_BYTES - prefix.length)).trim(),
        delivered: new Set(lesson.delivered),
      });
      index.set(lesson.projectKey, rows);
    }
    prepared = index;
  };
  board.onLessonChanged(refresh);
  refresh();
  const matches = (text: string) => prepared.size > 0 && text.length <= 2048 && phoneRequest.test(text) && !negation.test(text);

  return {
    matches,
    recover() {
      for (const post of board.list().filter(isLesson)) {
        if (post.lesson.originPc === pcId() && post.lesson.outcome === "pending" && !attempts.has(post.id)) {
          board.editLesson(post.id, lesson => ({ ...lesson, outcome: "skipped", endedAt: Date.now() }));
        }
      }
    },
    observe(source: Source, evidence: Evidence) {
      const failures = Object.entries(evidence.checks).filter(([, value]) => value === "missed").map(([rule]) => rule);
      if (!failures.length) return "";
      before.set(evidence.runId, { source, evidence, at: Date.now() });
      if (before.size > MAX_BEFORE) before.delete(before.keys().next().value!);
      if (attempts.size >= MAX_BEFORE) return "";
      return `To save this fix in Forum, recheck with verify_site. In entry put the same path, a newline, then JSON: {"beforeRunId":"${evidence.runId}","check":"${failures[0]}","problem":"...","change":"...","why":"...","expected":"..."}.${failures.length > 1 ? ` Failed checks: ${failures.join(", ")}.` : ""}`;
    },
    begin(source: Source, prediction: ForumPrediction, afterRunId: string, entry?: string): string | undefined {
      const prior = before.get(prediction.beforeRunId);
      if (!prior || Date.now() - prior.at > BEFORE_MS || !isAbsolute(source.project) || attempts.size >= MAX_BEFORE) return;
      const projectKey = folderKey(source.project);
      if (prior.source.botId !== source.botId || prior.source.threadId !== source.threadId || prior.source.model !== source.model
        || folderKey(prior.source.project) !== projectKey || prior.evidence.checks[prediction.check] !== "missed"
        || prior.evidence.entry !== entry) return;
      const { page } = prior.evidence;
      const changeId = afterRunId;
      const fields = {
        problem: redactSecretsInText(prediction.problem),
        change: redactSecretsInText(prediction.change),
        why: redactSecretsInText(prediction.why),
        expected: redactSecretsInText(prediction.expected),
      };
      for (const post of local) {
        if (post.lesson.projectKey === projectKey && post.lesson.page === page && post.lesson.check === prediction.check) {
          board.editLesson(post.id, lesson => ({ ...lesson, superseded: true }));
        }
      }
      const post = board.post({
        author_bot_id: source.botId,
        project_id: projectIdOf(source.project),
        kind: "fix",
        status: "open",
        source_ref: sourceRef(changeId),
        title: `Live Verify fix for ${page}`,
        body: `${fields.problem}\n\n${fields.change}\n\n${fields.why}`,
        lesson: { ...prediction, ...fields, changeId, projectKey, page, model: source.model.slice(0, 160), predictedAt: Date.now(), afterRunId, outcome: "pending", originPc: pcId() },
      });
      before.delete(prediction.beforeRunId);
      attempts.set(post.id, prior.evidence);
      return post.id;
    },
    finish(id: string, after?: Evidence, evidence?: NonNullable<LessonPost["lesson"]["evidence"]>) {
      const attempt = attempts.get(id);
      if (!attempt) return;
      attempts.delete(id);
      board.editLesson(id, lesson => {
        const measured = after?.runId === lesson.afterRunId && attempt.page === after.page
          && (!after.revision || after.revision !== attempt.revision) ? after.checks[lesson.check] : undefined;
        return { ...lesson, endedAt: Date.now(), outcome: measured === "passed" ? "fixed" : measured === "missed" ? "missed" : "skipped", evidence };
      });
    },
    take(input: Request) {
      if (input.room || !input.project || !matches(input.text)) return;
      const rows = prepared.get(folderKey(input.project));
      if (!rows) return;
      const matching = rows.filter(row => row.page.test(input.text.replaceAll("\\", "/")));
      if (matching.length !== 1) return;
      const { post, text, delivered } = matching[0]!;
      if (post.author_bot_id === input.botId && post.lesson.model === input.model) return;
      const recipient = hash(JSON.stringify([input.botId, input.model]));
      const claim = `${post.id}/${recipient}`;
      if (delivered.has(recipient) || reserved.has(claim)) return;
      reserved.add(claim);
      const release = () => reserved.delete(claim);
      return {
        text,
        release,
        accept() {
          try {
            board.editLesson(post.id, lesson => ({ ...lesson, delivered: [...(lesson.delivered ?? []), recipient].sort() }));
          } finally { release(); }
        },
      };
    },
  };
}

export type ForumLessons = ReturnType<typeof createForumLessons>;
