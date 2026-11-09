// PreToolUse hook for the quick helper fork: up to 3 Read/Glob/Grep calls inside the roots, everything else denied.
// argv[2] is the fork's temp dir: side-hook.json holds { roots }, read-<n> files claim the read slots.
const { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");

const READS = new Set(["Read", "Glob", "Grep"]);
const MAX_READS = 3;
const REASON = "Quick answers are read-only: Read, Glob or Grep, at most 3. If you cannot answer that way, reply with exactly HANDOFF.";

const dir = process.argv[2];
let input = {};
let roots = [];
try {
  input = JSON.parse(readFileSync(0, "utf8"));
  roots = [...new Set(JSON.parse(readFileSync(join(dir, "side-hook.json"), "utf8")).roots.flatMap((root) => [resolve(root), real(resolve(root))]))];
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

function within(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Below the root, a link is read but not followed until its target is inside a root too.
function linksStay(root, full, hops = 0) {
  const parts = relative(root, full).split(sep).filter(Boolean);
  let at = root;
  for (let i = 0; i < parts.length; i += 1) {
    at = join(at, parts[i]);
    try {
      if (!lstatSync(at).isSymbolicLink()) continue;
    } catch (error) {
      // only a missing part is safe: one that cannot be inspected may hide a link below it
      return error.code === "ENOENT";
    }
    let link;
    try {
      link = readlinkSync(at);
    } catch {
      return false;
    }
    const target = resolve(dirname(at), link);
    const next = roots.find((other) => within(other, target));
    return next !== undefined && hops < 40 && linksStay(next, join(target, ...parts.slice(i + 1)), hops + 1);
  }
  return true;
}

// Out-of-root input, UNC and device paths included, is refused before any filesystem call: a probe alone can reach a network host.
function inside(path) {
  const full = resolve(input.cwd || roots[0] || ".", path);
  const root = roots.find((other) => within(other, full));
  if (root === undefined || !linksStay(root, full)) return false;
  const found = real(full);
  return roots.some((other) => within(other, found));
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
