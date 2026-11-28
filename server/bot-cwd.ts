// A bot's working folder — where its shell tools run. Validated here, once,
// so a bad path is refused at PATCH time with a reason the settings panel
// can show, rather than surfacing later as a driver spawn failure.
import { statSync, type Stats } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

function unquotePath(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/** UNC and device paths (`\\host\share`, `//host/share`, `\\?\`, `\\.\`) make Windows reach the network on a stat. */
export function isNetworkPath(input: unknown): boolean {
  return typeof input === "string" && /^[\\/]{2}/.test(unquotePath(input.trim()));
}

/** The absolute folder `input` names, or its answer when no folder needs checking. */
function cwdToCheck(input: unknown): CwdValidation | string {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: "working folder must be a path" };
  const trimmed = unquotePath(input.trim());
  if (!trimmed) return { ok: true, cwd: null };
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? homedir() + trimmed.slice(1).replace(/\\/g, "/")
      : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  return resolve(expanded);
}

function checkedCwd(cwd: string, stat: Stats | undefined): CwdValidation {
  if (!stat) return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  return { ok: true, cwd };
}

export function validateBotCwd(input: unknown): CwdValidation {
  const cwd = cwdToCheck(input);
  if (typeof cwd !== "string") return cwd;
  let stat;
  try {
    stat = statSync(cwd);
  } catch {}
  return checkedCwd(cwd, stat);
}

/** validateBotCwd with its stat on the thread pool, so a batch of checks leaves the server free. */
export async function validateBotCwdAsync(input: unknown): Promise<CwdValidation> {
  const cwd = cwdToCheck(input);
  if (typeof cwd !== "string") return cwd;
  return checkedCwd(cwd, await statAsync(cwd).catch(() => undefined));
}
