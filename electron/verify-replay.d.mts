export declare const REPLAY_LIMIT: number;
export declare function chunk(kind: number, value: unknown): Buffer;
export interface ReplayChunk { kind: number; raw: Buffer; value: Record<string, unknown>; tile?: string; ms?: number; data?: Buffer; [key: string]: unknown }
export declare function decodeChunks(onChunk: (value: ReplayChunk) => void): { push(bytes: Uint8Array): void; end(): void };
