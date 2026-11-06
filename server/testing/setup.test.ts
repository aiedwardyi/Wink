import { describe, expect, it } from "vitest";

describe("test setup", () => {
  it("drops inherited account login dirs", () => {
    for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "CODEX_SQLITE_HOME"]) expect(process.env[name]).toBeUndefined();
  });
});
