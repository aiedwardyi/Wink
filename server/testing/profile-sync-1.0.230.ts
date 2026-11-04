import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import type { ProfileSyncOperation } from "../profile-sync.ts";

// Frozen reader from 9ec13d29; keep its schemas independent of the current writer.
const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
const MASCOT_STYLES = ["peach", "teal", "lavender", "coral", "squircle", "circle", "pill"] as const;
const BOT_AVATAR_IDS = [
  "icon-01",
  "icon-02",
  "icon-03",
  "icon-04",
  "icon-05",
  "icon-06",
  "icon-07",
  "icon-08",
  "icon-09",
  "icon-10",
  "icon-11",
  "icon-12",
  "icon-13",
  "icon-14",
  "icon-15",
  "icon-16",
  "icon-17",
  "icon-18",
  "icon-19",
  "icon-20",
  "icon-21",
  "icon-22",
  "icon-23",
  "icon-24",
  "icon-25",
  "icon-26",
  "icon-27",
  "icon-28",
  "icon-29",
  "icon-30",
  "icon-31",
  "icon-32",
  "icon-33",
  "icon-34",
  "icon-35",
  "icon-36",
  "icon-37",
  "icon-38",
  "icon-39",
  "icon-40",
  "icon-41",
  "icon-42",
  "icon-43",
  "icon-44",
  "icon-45",
  "icon-46",
  "icon-47",
  "icon-48",
  "icon-49",
] as const;
const botAvatarChoiceSchema = z.union([z.enum(MASCOT_STYLES), z.enum(BOT_AVATAR_IDS)]);

const PROFILE_SYNC_FORMAT = "orbit.profile-sync" as const;
const PROFILE_SYNC_VERSION = 1 as const;
const PROFILE_SYNC_CHANGES_DIR = "changes";
const PROFILE_SYNC_MAX_FILES = 100_000;

const ID = z.string().trim().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const COLOR = z.enum([
  "green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral", "white", "black", "gray",
]);
const portableBotChanges = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(4_000).optional(),
  color: COLOR.optional(),
  mascotExpression: z.string().trim().max(80).nullable().optional(),
  mascotStyle: botAvatarChoiceSchema.nullable().optional(),
  avatarAsset: z.string().trim().max(240).nullable().optional(),
  avatarCrop: botAvatarCropSchema.optional(),
  sectionId: ID.nullable().optional(),
  pinned: z.boolean().optional(),
  chiefOfStaff: z.boolean().optional(),
  instanceId: z.string().trim().max(160).nullable().optional(),
  model: z.string().trim().max(160).nullable().optional(),
  effort: z.string().trim().max(40).nullable().optional(),
  modelMode: z.enum(["automatic", "pinned"]).nullable().optional(),
  approvePeerComms: z.boolean().optional(),
  memoryNotes: z.boolean().nullable().optional(),
  memoryDocument: z.string().trim().max(240).nullable().optional(),
  projectNotes: z.string().trim().max(1_024).nullable().optional(),
  pinnedMessageId: ID.nullable().optional(),
}).strict();
const sectionChanges = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  order: z.number().int().min(0).max(10_000).optional(),
}).strict();
const orderChanges = z.object({
  sectionOrder: z.array(ID).max(200).optional(),
  itemOrder: z.record(z.string().max(96), z.array(ID).max(500)).optional(),
}).strict();

const operationSchema = z.object({
  format: z.literal(PROFILE_SYNC_FORMAT),
  version: z.literal(PROFILE_SYNC_VERSION),
  operationId: ID,
  deviceId: ID,
  sequence: z.number().int().positive().max(2_000_000_000),
  recordedAt: z.number().int().positive().max(9_999_999_999_999),
  baseCheckpoint: z.string().trim().max(160).optional(),
  entity: z.enum(["bot", "section", "order"]),
  entityId: ID,
  changes: z.record(z.string().max(64), z.json()).optional(),
  deleted: z.boolean().optional(),
}).strict();

function validateChanges(operation: ProfileSyncOperation): Record<string, unknown> | undefined {
  if (!operation.changes) return undefined;
  const schema = operation.entity === "bot"
    ? portableBotChanges
    : operation.entity === "section"
      ? sectionChanges
      : orderChanges;
  const parsed = schema.safeParse(operation.changes);
  if (!parsed.success) throw new Error(`Invalid ${operation.entity} sync changes`);
  return parsed.data as Record<string, unknown>;
}

export function parseSyncOperation(value: unknown): ProfileSyncOperation {
  const parsed = operationSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid profile sync operation");
  const operation = parsed.data as ProfileSyncOperation;
  if (!operation.deleted && !operation.changes) throw new Error("Sync operation has no changes");
  validateChanges(operation);
  return operation;
}

export function parseSyncOperationText(text: string): ProfileSyncOperation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Profile sync file is not valid JSON");
  }
  return parseSyncOperation(value);
}

const isSyncOperationFile = (name: string) => /\.(?:json|notes|paths|pin|style)$/.test(name);

export function readSyncOperations(folder: string): { operations: ProfileSyncOperation[]; invalidFiles: string[]; truncated: boolean } {
  const directory = join(folder, PROFILE_SYNC_CHANGES_DIR);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return { operations: [], invalidFiles: [], truncated: false };
  }
  const operations: ProfileSyncOperation[] = [];
  const invalidFiles: string[] = [];
  const jsonNames = names.filter(isSyncOperationFile).sort();
  const truncated = jsonNames.length > PROFILE_SYNC_MAX_FILES;
  for (const name of jsonNames.slice(0, PROFILE_SYNC_MAX_FILES)) {
    const path = join(directory, basename(name));
    try {
      operations.push(parseSyncOperationText(readFileSync(path, "utf8")));
    } catch {
      invalidFiles.push(name);
    }
  }
  if (truncated) invalidFiles.push("[profile sync change log exceeds the supported file limit]");
  return { operations, invalidFiles, truncated };
}
