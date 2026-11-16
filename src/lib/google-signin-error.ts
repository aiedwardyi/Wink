import type { MessageKey } from "@/lib/i18n";

/** Every failure code electron/google-signin.mjs returns from signIn. */
export type GoogleSignInCode =
  | "unavailable"
  | "cancelled"
  | "timeout"
  | "state-mismatch"
  | "access-denied"
  | "blocked"
  | "google-error"
  | "browser-failed"
  | "exchange-failed"
  | "offline"
  | "drive-permission-missing"
  | "store-failed";

// null: the user stopped it themselves, so there is nothing to say.
export const GOOGLE_SIGN_IN_MESSAGES = {
  unavailable: "settings.googleSignIn.unavailable",
  cancelled: null,
  timeout: "settings.googleSignIn.timeout",
  "state-mismatch": "settings.googleSignIn.failed",
  "access-denied": "settings.googleSignIn.denied",
  blocked: "settings.sync.blocked",
  "google-error": "settings.googleSignIn.failed",
  "browser-failed": "settings.googleSignIn.browser",
  "exchange-failed": "settings.googleSignIn.failed",
  offline: "settings.googleSignIn.offline",
  "drive-permission-missing": "settings.googleSignIn.drive",
  "store-failed": "settings.googleSignIn.store",
} satisfies Record<GoogleSignInCode, MessageKey | null>;

export function googleSignInError(code: string): MessageKey | null {
  // SAFETY: hasOwn proves code is one of the map's own keys.
  return Object.hasOwn(GOOGLE_SIGN_IN_MESSAGES, code) ? GOOGLE_SIGN_IN_MESSAGES[code as GoogleSignInCode] : "settings.googleSignIn.failed";
}
