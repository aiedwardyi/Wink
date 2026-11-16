export const CLAUDE_PANE_ENV: Readonly<{ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: string }>;
export const CODE_MODE_CAVEATS: readonly string[];
export function claudeConfigFile(env: Record<string, string | undefined>, platform?: NodeJS.Platform): string | null;
export function withClaudePaneEnv<T extends Record<string, string | undefined>>(env: T, platform?: NodeJS.Platform): Promise<T>;
