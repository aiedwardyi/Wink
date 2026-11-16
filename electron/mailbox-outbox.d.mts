export function deliverMailboxOutbox(profile: string, url: string, runs?: {
  restarted(): Map<string, Array<{ id: string; botId: string; teacher?: string }>>;
  closed(id: string): boolean | Promise<boolean>;
}, options?: { budgetMs?: number }): Promise<{
  delivered: number;
  reports: Array<{ pane: string; bot: string; teacher: string }>;
  pendingReports: Array<{ pane: string; bot: string; teacher: string }>;
  unreadable: boolean;
}>;
