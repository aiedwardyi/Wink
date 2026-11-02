export interface FeatureFlagConfig {
  features?: { showToolCalls?: boolean; detailedReplies?: boolean; memoryNotes?: boolean; modelDial?: boolean };
}

export function detailedRepliesEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.detailedReplies === true;
}

/** Background chat notes into MEMORY.md. The bot's own switch, else the old global one, on unless switched off. */
export function memoryNotesEnabled(config: FeatureFlagConfig | null | undefined, bot?: { memoryNotes?: boolean } | null): boolean {
  return bot?.memoryNotes ?? (config?.features?.memoryNotes !== false);
}

export function modelDialEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.modelDial === true;
}

/** Tool-run chips in the transcript. Off by default — the mascot already
 * shows that work is happening. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}
