// Static on purpose: a resumed session is told each change to the system text.
export const CODE_FIX_INSTRUCTIONS =
  " When writing or fixing code (the user's own instructions override this): fix the root cause; no timer, retry or comment patching around it. Make it unrepeatable: a lint rule whose error names the fix, a type, a right-way-only API, or a test failing on the old bug; prose rules last. Add the check first, then list other copies of the bad pattern to clean. Prove it by running the code yourself: red-then-green tests, screenshots, clips. A report is a claim, not proof.";
