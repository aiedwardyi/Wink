// Stand-in for `claude -p --output-format json` in the dream tests: answers each cleaner prompt the way a model would and echoes
// DREAM_STUB_MARKER into its reply, its stderr, its error text and a session trace, so a test can prove none of them leaves dream-practice.
// DREAM_STUB_FAIL: a word; a prompt holding it fails, with the marker in stderr. It also answers the practice kit's item writer, turns and grader.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const marker = process.env.DREAM_STUB_MARKER ?? "";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

if (!args.includes("--no-session-persistence") && process.env.CLAUDE_CONFIG_DIR) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "stub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.jsonl`), JSON.stringify({ prompt, marker }) + "\n");
}
process.stderr.write(`stub engine ${marker}\n`);
if (process.env.DREAM_STUB_FAIL && prompt.includes(process.env.DREAM_STUB_FAIL)) {
  process.stderr.write(`stub claude failed on ${marker}\n`);
  process.exit(1);
}

const topic = "memory/stub-notes.md";
const numbered = (pattern) => [...prompt.matchAll(pattern)].map((match) => match[1]);
let reply;
if (prompt.includes("You file a bot's notes")) {
  reply = { files: [{ topic: "stub-notes.md", about: "Stub details", when: "before stub work", notes: numbered(/^(L\d+) \(/gm).slice(0, 2) }] };
} else if (prompt.includes("For each note below, name the one file")) {
  reply = Object.fromEntries(numbered(/^(N\d+): /gm).map((ref) => [ref, topic]));
} else if (prompt.includes("write 3 questions")) {
  reply = Object.fromEntries(numbered(/<block id="(B\d+)">/g).map((ref) => [ref, [1, 2, 3].map((n) => `Question ${n} about ${marker}?`)]));
} else if (prompt.startsWith("Write check items")) {
  const item = (n) => ({ question: `Where does check ${n} about ${marker} stand?`, rubric: `Names the ${marker} note ${n}` });
  reply = { blind: item(1), cued: item(2) };
  if (prompt.includes("sentinels:")) reply.sentinels = [item(3), item(4)];
} else if (prompt.startsWith("Grade a bot's answer")) {
  // DREAM_STUB_MISS: a word; an answer holding it is graded a miss
  reply = { pass: !(process.env.DREAM_STUB_MISS && prompt.split("Answer:")[1]?.includes(process.env.DREAM_STUB_MISS)) };
} else if (prompt.startsWith("Where does check")) {
  reply = { answer: `It stands in the notes ${marker}` };
} else if (prompt.includes("For each question, name the one file")) {
  reply = Object.fromEntries(numbered(/^(Q\d+): /gm).map((ref) => [ref, topic]));
} else {
  reply = { duplicates: [], disagree: [] };
}
process.stdout.write(JSON.stringify({
  result: `${JSON.stringify(reply)} ${marker}`,
  usage: { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 200, output_tokens: 100 },
}));
