import { describe, expect, it } from "vitest";
import { isSignOut } from "./signout";

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
});
