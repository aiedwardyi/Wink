import { z } from "zod";

const note = z.string().trim().min(1).max(240);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

export const predictionSchema = z.object({
  beforeRunId: id,
  check: z.string().regex(/^[A-Z_]+\/(phone|desktop)(\/[a-z ]+)?$/).max(64),
  problem: note,
  change: note,
  why: note,
  expected: note,
}).strict();

export const lessonSchema = predictionSchema.extend({
  changeId: id,
  projectKey: z.string().regex(/^[a-f0-9]{64}$/),
  page: z.string().min(1).max(1024),
  model: z.string().max(160),
  predictedAt: z.number().int().nonnegative(),
  afterRunId: id,
  outcome: z.enum(["pending", "fixed", "missed", "skipped"]),
  endedAt: z.number().int().nonnegative().optional(),
  evidence: z.object({ threadId: id, messageId: id }).optional(),
  originPc: z.string(),
  superseded: z.boolean().optional(),
  delivered: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
});
