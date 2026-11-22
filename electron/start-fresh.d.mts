export function resetMarkerPath(dataDir: string): string;
export function requestStartFresh(options: { dataDir: string; now?: Date }): void;
export function applyStartFresh(options: {
  dataDir: string;
  userData: string;
  clearUiState: () => Promise<void> | void;
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ status: "none" | "reset" | "failed"; backup?: string; error?: string }>;
