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

  it("leaves a 403 permission error alone", () => {
    expect(isSignOut(`Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Forbidden"}}`)).toBe(false);
  });
});
