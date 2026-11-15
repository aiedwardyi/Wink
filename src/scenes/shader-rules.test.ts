import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "src/scenes");
const scenes = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

function args(src: string, at: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = at;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return [...out, src.slice(start, i).trim()];
      depth--;
    } else if (c === "," && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  return out;
}

// Uniforms and locals stand in as 100; an edge that is not plain arithmetic is skipped.
function value(expr: string): number | undefined {
  const plain = expr.replace(/\b[A-Za-z_]\w*(\.\w+)?\b/g, "100");
  if (!/^[\d.+\-*/() ]+$/.test(plain)) return undefined;
  const n = Function(`return (${plain})`)() as unknown;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

describe("scene shaders", () => {
  it.each(scenes)("%s keeps smoothstep edges ascending", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    const bad: string[] = [];
    for (const m of src.matchAll(/\bsmoothstep\(/g)) {
      const [a, b] = args(src, m.index! + m[0].length);
      const lo = value(a ?? "");
      const hi = value(b ?? "");
      if (lo !== undefined && hi !== undefined && lo >= hi) bad.push(`smoothstep(${a}, ${b}, ...)`);
    }
    expect(bad, "GLSL leaves smoothstep undefined when edge0 >= edge1; write 1.0 - smoothstep(lo, hi, x) for a falling ramp").toEqual([]);
  });
});
