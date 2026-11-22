#!/usr/bin/env node
// Fake of the Antigravity `agy` CLI's print-mode stdio surface, for driver
// tests of drivers/antigravity.ts. On `--version` it prints a version; on a
// stream-json print-mode invocation (`--input-format stream-json
// --output-format stream-json`) it reads one NDJSON user event from stdin
// (agy 1.1.15+ / verified 1.2.4: {"event":"user","message":{...}}), then
// emits a canned NDJSON turn: init → tool step (ACTIVE then DONE) →
// agent_response step with usage → result with status SUCCESS.
// While FAKE_AGY_CHECKPOINT_FILE exists, agy's checkpoint step precedes the response;
// while FAKE_AGY_RESUME_FAIL_FILE exists, `--conversation` launches fail.
// FAKE_AGY_RESULT_ERROR, when set, is the result.error of a status ERROR turn.
// FAKE_AGY_RESULT_RESPONSE, with it, is that turn's result.response (else "").
// While FAKE_AGY_RESULT_ERROR_FILE exists, its text is that result.error.
// FAKE_AGY_CREDENTIAL_FILE, when set, is agy's saved sign-in, reread for the request as agy before 1.5 does:
// while it is missing, the turn fails as signed out (401).
// FAKE_AGY_DENIED_MODEL, when set, is a --model whose turns fail with Vertex's permission denial.
// FAKE_AGY_USAGE, when set, is the JSON usage on the response step and the result.
// FAKE_AGY_STREAM=1 streams result.response as two text_delta steps first.
// FAKE_AGY_WRITE_HOME=1 writes what real agy writes under HOME/.gemini on a turn.
// Deterministic, no network.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
if (process.env.FAKE_AGY_READY_FILE) {
  writeFileSync(process.env.FAKE_AGY_READY_FILE, "ready");
}
if (argv.includes("--version")) {
  if (process.env.FAKE_AGY_DUMP) {
    writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env }, null, 2));
  }
  console.log("1.1.12");
  process.exit(0);
}

// `-p /usage`: FAKE_AGY_USAGE_MODE_FILE names a file holding the mode, read on every call so a test can switch
// accounts without a restart. plan = FAKE_AGY_USAGE_FIXTURE's stream-json lines; apikey = agy's own refusal
// (exit 2); adc = what agy 1.5.12 printed for Cloud ADC with unusable credentials (exit 1, "authentication required");
// transient = any other plain failure (exit 1); signedout = empty groups, exit 0.
if (argv.includes("-p") && argv[argv.indexOf("-p") + 1] === "/usage") {
  const mode = process.env.FAKE_AGY_USAGE_MODE_FILE && existsSync(process.env.FAKE_AGY_USAGE_MODE_FILE)
    ? readFileSync(process.env.FAKE_AGY_USAGE_MODE_FILE, "utf8").trim() : "plan";
  if (mode === "plan" && process.env.FAKE_AGY_USAGE_FIXTURE) {
    process.stdout.write(readFileSync(process.env.FAKE_AGY_USAGE_FIXTURE, "utf8"));
    process.exit(0);
  }
  if (mode === "signedout") {
    process.stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "usage", data: { groups: [] } } })}\n`);
    process.exit(0);
  }
  if (mode === "apikey") {
    process.stderr.write("/usage is not available with a Gemini API key\n");
    process.exit(2);
  }
  if (mode === "adc") {
    process.stdout.write(`${JSON.stringify({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out", finished_reason: "error" } })}\n`);
    process.stderr.write("Error: authentication required. Run 'agy.exe' to log in.\nerror: authentication failed or timed out\n");
    process.exit(1);
  }
  process.stderr.write("usage failed\n");
  process.exit(1);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function promptFromStreamJson(raw: string): string | undefined {
  const line = raw.split(/\r?\n/).find((row) => row.trim());
  if (!line) return undefined;
  let msg: { event?: unknown; message?: { content?: unknown } };
  try {
    msg = JSON.parse(line) as { event?: unknown; message?: { content?: unknown } };
  } catch {
    process.stderr.write("error: stream input message is not valid JSON\n");
    process.exit(1);
  }
  if (msg.event !== "user") {
    process.stderr.write('error: stream input message is missing the "event" field\n');
    process.exit(1);
  }
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (content == null) return undefined;
  return JSON.stringify(content);
}

const inputFormatIdx = argv.indexOf("--input-format");
const inputFormat = inputFormatIdx !== -1 ? argv[inputFormatIdx + 1] : undefined;
const printIdx = argv.includes("--print") ? argv.indexOf("--print") : argv.indexOf("-p");
let stdinRaw = "";
let prompt: string | undefined;
if (inputFormat === "stream-json") {
  stdinRaw = await readStdin();
  prompt = promptFromStreamJson(stdinRaw);
} else if (printIdx !== -1) {
  prompt = argv[printIdx + 1];
}

if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(
    process.env.FAKE_AGY_DUMP,
    JSON.stringify(
      {
        argv,
        env: process.env,
        // Lengths only — tests that need the prompt body read `prompt` explicitly.
        stdinBytes: Buffer.byteLength(stdinRaw),
        promptChars: prompt?.length ?? 0,
        prompt,
      },
      null,
      2,
    ),
  );
}

const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
// Held open until the test creates this file, so overlapping turns are observable.
while (process.env.FAKE_AGY_HOLD_FILE && !existsSync(process.env.FAKE_AGY_HOLD_FILE)) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const home = process.env.HOME || process.env.USERPROFILE || "";
if (process.env.FAKE_AGY_MCP_DUMP) {
  let config = "null";
  try {
    config = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
  } catch {}
  writeFileSync(process.env.FAKE_AGY_MCP_DUMP, config);
}

if (process.env.FAKE_AGY_WRITE_HOME === "1" && prompt) {
  const gemini = join(home, ".gemini");
  const cli = join(gemini, "antigravity-cli");
  const id = `helper-${process.pid}`;
  for (const dir of ["conversations", "log", `brain/${id}`, "cache", "presence"]) mkdirSync(join(cli, dir), { recursive: true });
  writeFileSync(join(cli, "conversations", `${id}.db`), "conversation");
  writeFileSync(join(cli, "brain", id, "note.md"), "brain");
  writeFileSync(join(cli, "presence", `${id}.lock`), "lock");
  appendFileSync(join(cli, "log", `cli-${id}.log`), "helper log\n");
  writeFileSync(join(cli, "cache", "last_conversations.json"), JSON.stringify({ [process.cwd()]: id }));
  writeFileSync(join(cli, "settings.json"), JSON.stringify({ trustedFolders: [process.cwd()] }));
  writeFileSync(join(gemini, "state.json"), JSON.stringify({ last: id }));
  appendFileSync(join(gemini, "trustedFolders.json"), `${process.cwd()}\n`);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const CONV = "conv-fake-123";
const systemNotice = "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>internal notice</SYSTEM_MESSAGE>";
const cancelledTool = process.env.FAKE_AGY_CANCELLED_TOOL === "1";
const errorFile = process.env.FAKE_AGY_RESULT_ERROR_FILE;
const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;
const deniedModel = process.env.FAKE_AGY_DENIED_MODEL && model === process.env.FAKE_AGY_DENIED_MODEL
  ? `Permission 'aiplatform.endpoints.predict' denied on resource '/publishers/google/models/${model.replace(/-low$/, "")}' (or it may not exist).`
  : undefined;
const credentialFile = process.env.FAKE_AGY_CREDENTIAL_FILE;
const signedOut = credentialFile && !existsSync(credentialFile) ? "Request failed with status 401: UNAUTHENTICATED" : undefined;
const resultError = signedOut || deniedModel || process.env.FAKE_AGY_RESULT_ERROR || (errorFile && existsSync(errorFile) ? readFileSync(errorFile, "utf8") : undefined);

// stream-json / --print with no prompt yields no turn (mirrors real CLI).
if (!prompt) process.exit(0);
const resumeFails = Boolean(process.env.FAKE_AGY_RESUME_FAIL)
  || Boolean(process.env.FAKE_AGY_RESUME_FAIL_FILE && existsSync(process.env.FAKE_AGY_RESUME_FAIL_FILE));
if (resumeFails && argv.includes("--conversation")) {
  const diagnostic = process.env.FAKE_AGY_RESUME_FAIL === "multiline"
    ? "agy: conversation 8f2c\nnot found\n"
    : "agy: conversation not found\n";
  await new Promise<never>(() => {
    process.stderr.write(diagnostic, () => process.exit(4));
  });
}

if (process.env.FAKE_AGY_REPLAY) {
  for (const line of JSON.parse(process.env.FAKE_AGY_REPLAY)) out(line);
  process.exit(0);
}

out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file"], permission_mode: "accept-edits" } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
out({
  event: "step_update",
  conversation_id: CONV,
  step_update: {
    conversation_id: CONV,
    step_index: 0,
    state: cancelledTool ? "ERROR" : "DONE",
    step_type: "tool",
    tool_name: "write_to_file",
    tool_info: cancelledTool
      ? { name: "write_to_file", parameters: {}, output: "context canceled" }
      : { name: "write_to_file", parameters: {} },
  },
});
if (process.env.FAKE_AGY_CHECKPOINT_FILE && existsSync(process.env.FAKE_AGY_CHECKPOINT_FILE)) {
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 3, state: "DONE", step_type: "checkpoint", duration_seconds: 9.7 } });
}
if (process.env.FAKE_AGY_SYSTEM_NOTICE === "1") {
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 2, state: "DONE", step_type: "agent_response", text_delta: systemNotice } });
}
const response = resultError
  ? (process.env.FAKE_AGY_RESULT_RESPONSE ?? "")
  : process.env.FAKE_AGY_SYSTEM_NOTICE === "1"
    ? systemNotice + (process.env.FAKE_AGY_AFTER_NOTICE ?? "")
    : process.env.FAKE_AGY_NO_FINAL === "1"
      ? ""
      : cancelledTool
        ? "final text after cancellation"
        : "done from fake agy";
if (process.env.FAKE_AGY_STREAM === "1") {
  const half = Math.ceil(response.length / 2);
  for (const text_delta of [response.slice(0, half), response.slice(half)].filter(Boolean)) {
    out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta } });
  }
}
const fakeUsage = process.env.FAKE_AGY_USAGE
  ? JSON.parse(process.env.FAKE_AGY_USAGE)
  : { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 };
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", usage: fakeUsage } });
if (resultError && process.env.FAKE_AGY_LAST_STEP_TYPE) {
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 2, state: process.env.FAKE_AGY_LAST_STEP_STATE ?? "DONE", step_type: process.env.FAKE_AGY_LAST_STEP_TYPE } });
}
out({
  event: "result",
  conversation_id: CONV,
  result: {
    conversation_id: CONV,
    status: resultError ? "ERROR" : "SUCCESS",
    response,
    error: resultError,
    duration_seconds: 1,
    num_turns: 1,
    usage: fakeUsage,
  },
});
const postResultDelayMs = Number(process.env.FAKE_AGY_POST_RESULT_DELAY_MS ?? 0);
if (Number.isFinite(postResultDelayMs) && postResultDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
}
process.exit(0);
