// PreToolUse hook for the quick helper fork: up to 3 Read/Glob/Grep calls inside the roots, everything else denied.
// argv[2] is the fork's temp dir: side-hook.json holds { roots }, read-<n> files claim the read slots.
const { existsSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve } = require("node:path");

const READS = new Set(["Read", "Glob", "Grep"]);
const MAX_READS = 3;
const REASON = "Quick answers are read-only: Read, Glob or Grep, at most 3. If you cannot answer that way, reply with exactly HANDOFF.";

const dir = process.argv[2];
let input = {};
let roots = [];
try {
  input = JSON.parse(readFileSync(0, "utf8"));
  roots = JSON.parse(readFileSync(join(dir, "side-hook.json"), "utf8")).roots.map((root) => real(resolve(root)));
} catch {}

// A missing file resolves through its nearest real parent, or a linked or 8.3 root never matches it.
function real(path) {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

function inside(path) {
  const full = real(resolve(input.cwd || roots[0] || ".", path));
  return roots.some((root) => {
    const rel = relative(root, full);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

// A glob reaches as far as its fixed head.
function globHead(pattern) {
  const parts = pattern.split(/[\\/]/);
  const wild = parts.findIndex((part) => /[*?[{]/.test(part));
  const head = parts.slice(0, wild === -1 ? parts.length : wild).join("/");
  return head === "" && !isAbsolute(pattern) ? "." : `${head}/`;
}

function paths(tool, args) {
  if (tool === "Read") return [args.file_path ?? ""];
  const base = args.path ?? ".";
  if (tool !== "Glob" || typeof args.pattern !== "string") return [base];
  const head = globHead(args.pattern);
  return [base, isAbsolute(head) ? head : join(base, head)];
}

function claimRead() {
  for (let n = 1; n <= MAX_READS; n += 1) {
    try {
      writeFileSync(join(dir, `read-${n}`), "", { flag: "wx" });
      return true;
    } catch {}
  }
  return false;
}

const args = input.tool_input ?? {};
const allow = READS.has(input.tool_name) && roots.length > 0 && existsSync(dir) && paths(input.tool_name, args).every((path) => typeof path === "string" && path !== "" && inside(path)) && claimRead();
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allow ? "allow" : "deny", permissionDecisionReason: allow ? "Read-only quick answer." : REASON },
  }),
);
