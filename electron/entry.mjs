// package.json "main". Wink boots main.mjs; a verify child (LV0-S11-ARCH) never loads it.
const verifyChild = process.argv.includes("--orbit-verify-child") && /^[0-9a-f]{48}$/.test(process.env.ORBIT_VERIFY_CHILD ?? "");
if (verifyChild) await import("./verify-child.mjs").catch(() => process.exit(70));
else await import("./main.mjs");
