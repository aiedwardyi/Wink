import { randomUUID } from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function workerSession(engine: string, args: string[], env: NodeJS.ProcessEnv) {
  engine = engine.toLowerCase();
  if (engine !== "claude" && engine !== "codex") return undefined;
  for (const key of Object.keys(env)) {
    if (/^(?:CODEX_(?:THREAD|SESSION|TOOL_CALL)_ID|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_(?:CODE_)?SESSION(?:_ID)?)$/i.test(key)) delete env[key];
  }
  const option = (name: string, short?: string) => {
    for (let i = args.length - 1; i >= 0; i--) {
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
      if (args[i] === name || (short && args[i] === short)) return args[i + 1] ?? null;
    }
    return null;
  };
  let nativeId: string | null = null;
  if (engine === "claude" && !args.some((arg) => arg.startsWith("-r") || /^(?:--resume|-c|--continue)(?:=|$)/.test(arg))) {
    nativeId = option("--session-id");
    if (nativeId && !UUID.test(nativeId)) throw new Error("Invalid worker session id");
    if (!nativeId) { nativeId = randomUUID(); args.push("--session-id", nativeId); }
  }
  let effort = option("--effort");
  for (let i = 0; engine === "codex" && i < args.length; i++) {
    const value = /^(?:--config|-c)$/.test(args[i]) ? args[++i] : /^(?:--config=|-c=?)(.+)$/.exec(args[i])?.[1];
    const match = /^model_reasoning_effort\s*=\s*["']?([\w-]+)["']?$/.exec(value ?? "");
    if (match) effort = match[1];
    if (/^(?:hooks|"hooks"|'hooks')(?:[.\s=]|$)/.test(value?.trim() ?? "")) throw new Error("Conflicting worker hook configuration");
  }
  if (engine === "codex" && args.includes("--dangerously-bypass-hook-trust")) throw new Error("Conflicting worker hook trust");
  return { engine, launchGeneration: randomUUID(), nativeId, model: option("--model", "-m"), effort };
}
