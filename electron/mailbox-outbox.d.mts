export function deliverMailboxOutbox(profile: string, url: string, runs?: {
  restarted(): Map<string, Array<{ id: string; botId: string; teacher?: string }>>;
  closed(id: string): void;
}): Promise<{ delivered: number; reports: Array<{ pane: string; bot: string; teacher: string }> }>;
