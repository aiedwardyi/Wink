export function collectTurnTraces(records: unknown[]): Array<{ incomplete: boolean; unknownPhases: Array<{ phase: string; reason?: string }> }>;
