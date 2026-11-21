export interface ForumPrediction {
  beforeRunId: string;
  check: string;
  problem: string;
  change: string;
  why: string;
  expected: string;
}

export interface ForumLesson extends ForumPrediction {
  changeId: string;
  projectKey: string;
  page: string;
  model: string;
  predictedAt: number;
  afterRunId: string;
  outcome: "pending" | "fixed" | "missed" | "skipped";
  endedAt?: number;
  evidence?: { threadId: string; messageId: string };
}
