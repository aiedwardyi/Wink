import { describe, expect, it } from "vitest";
import { isSignOut } from "./signout.js";

describe("isSignOut", () => {
  it.each([
    "407 Proxy Authentication Required",
    "HTTP/1.1 407 proxy-authentication required",
  ])("leaves a proxy failure alone: %s", (message) => {
    expect(isSignOut(message)).toBe(false);
  });

  it("still marks a real authentication failure", () => {
    expect(isSignOut("Authentication required")).toBe(true);
  });

  it("marks the Claude CLI's 401 result", () => {
    expect(isSignOut(`Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."},"request_id":"req_1"}`)).toBe(true);
  });

  // the CLI's own words for an expired or revoked login (claude 2.1.328)
  it.each([
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs",
    "Failed to authenticate: this login reached its time limit \u00b7 Sign in again to continue",
    "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.",
    "Failed to authenticate: your claude.ai login expired. Claude Code tried Acme instead, but it doesn't have enough credit. Run `claude auth login` to sign in again, or add funds: https://platform.claude.com/settings/billing",
    "Login expired \u00b7 Please run /login",
    "OAuth token revoked \u00b7 Please run /login",
    "Login reached its time limit \u00b7 Please run /login",
    "OAuth refresh token is no longer valid; run /login to re-authenticate",
    "Your Claude session has expired. Sign in again to continue (claude auth login).",
  ])("marks an expired Claude login: %s", (message) => {
    expect(isSignOut(message)).toBe(true);
  });

  it.each([
    "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again",
    "Check your network connection, or run `claude auth login` to re-authenticate.",
    "MCP session expired during tool call (linear)",
    "Your session has expired. Please reauthenticate.",
  ])("leaves a refresh race, network or tool-server failure alone: %s", (message) => {
    expect(isSignOut(message)).toBe(false);
  });

  it("leaves a 403 permission error alone", () => {
    expect(isSignOut(`Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Forbidden"}}`)).toBe(false);
  });
});
