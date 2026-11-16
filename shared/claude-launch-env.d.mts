export const CLAUDE_LAUNCH_ENV: Readonly<Record<string, string>>;
export function claudeUserSettingsEnv(env: Record<string, string | undefined>): Record<string, unknown>;
export function withClaudeLaunchEnv<T extends Record<string, string | undefined>>(env: T, settingsEnv?: Record<string, unknown>): T;
