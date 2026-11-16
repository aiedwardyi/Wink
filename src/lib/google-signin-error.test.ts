import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { translate } from "./i18n";
import { GOOGLE_SIGN_IN_MESSAGES, googleSignInError } from "./google-signin-error";

const main = readFileSync(new URL("../../electron/google-signin.mjs", import.meta.url), "utf8");
// Every kebab literal where a failure is built or returned; "error" is Google's own query name.
const sources = [
  ...[...main.matchAll(/new GoogleSignInError\((.*)\)/g)].map((match) => match[1]!),
  ...main.split("\n").filter((line) => /ERROR_CODES = |error\.code : |error: "/.test(line)),
];
const codes = [...new Set(sources.flatMap((text) => [...text.matchAll(/"([a-z]+(?:-[a-z]+)*)"/g)].map((match) => match[1]!)).filter((code) => code !== "error"))];

describe("Google sign-in failure text", () => {
  it("has plain words for every code the desktop app can return", () => {
    expect(codes).toEqual(expect.arrayContaining(["drive-permission-missing", "access-denied", "timeout", "offline", "exchange-failed", "blocked", "store-failed", "unavailable", "google-error"]));
    expect(Object.keys(GOOGLE_SIGN_IN_MESSAGES).sort()).toEqual([...codes].sort());
  });

  it.each(["en", "ko"] as const)("never shows a raw code in %s", (locale) => {
    for (const code of codes) {
      const key = googleSignInError(code);
      if (code === "cancelled") expect(key).toBeNull();
      else expect(translate(locale, key!)).not.toMatch(/^[a-z-]+$/);
    }
    expect(translate(locale, googleSignInError("unheard-of")!)).toBe(translate(locale, "settings.googleSignIn.failed"));
  });
});
