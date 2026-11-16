// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWebPushState } from "./web-push";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

function phone(userAgent: string, standalone: boolean) {
  vi.stubGlobal("isSecureContext", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: standalone && query === "(display-mode: standalone)" }) as MediaQueryList);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("phone notifications without push support", () => {
  it("asks an iPhone browser tab to add Wink to the Home Screen", async () => {
    phone(IPHONE, false);
    expect("PushManager" in window).toBe(false);
    expect(await readWebPushState()).toBe("install");
  });

  it.each([["an installed iPhone app too old for push", IPHONE, true], ["an Android browser without push", ANDROID, false]])("stays unsupported for %s", async (_name, userAgent, standalone) => {
    phone(userAgent, standalone);
    expect(await readWebPushState()).toBe("unsupported");
  });
});
