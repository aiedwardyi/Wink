import { factParts } from "../memory-clean-coverage.ts";

export function sleepRoutes(prompt: string) {
  const sources = JSON.parse(/^Route sources: (.*)$/m.exec(prompt)![1]!) as Array<{ id: number; text: string }>;
  return sources.flatMap(({ id, text }) => factParts(text).map((fact, index) => {
    const label = fact.replace(/[a-z]{40,}/gi, "").trim();
    return { id, fact, label, question: `Which file holds source ${id} part ${index}: ${label}?`, valueQuestion: `What is recorded for source ${id} part ${index}?`, answer: fact };
  }));
}

export function sleepReply(prompt: string): string | null {
  if (prompt.startsWith("[memory-clean:organize]")) {
    const checks = JSON.parse(/^Checks: (.*)$/m.exec(prompt)![1]!) as unknown[];
    return JSON.stringify({ verdicts: checks.map(() => true), corrections: [] });
  }
  if (prompt.startsWith("[memory-clean:route-questions]")) return JSON.stringify(sleepRoutes(prompt));
  if (prompt.startsWith("[memory-clean:routes]")) {
    const questions = JSON.parse(/^Questions: (.*)$/m.exec(prompt)![1]!) as string[];
    const index = prompt.slice(prompt.indexOf("MEMORY.md:\n"));
    const path = /memory\/(?!memory-history)[\w.-]+\.md/.exec(index)?.[0] ?? null;
    const rows = [...index.matchAll(/^- (memory\/(?!memory-history)[\w.-]+\.md): (.*)$/gm)];
    const words = (text: string) => new Set(text.toLowerCase().match(/[a-z가-힣]{3,}|\d+/g));
    // with several topics a question goes to the row sharing the most words with it
    return JSON.stringify(questions.map((question) => rows.length < 2 ? path : rows.map(([, file, label]) => ({ file, hits: [...words(label!)].filter((word) => words(question.slice(question.indexOf(": ") + 1)).has(word)).length }))
      .sort((a, b) => b.hits - a.hits)[0]!.file));
  }
  if (prompt.startsWith("[memory-clean:values]")) {
    const questions = JSON.parse(/^Questions: (.*)$/m.exec(prompt)![1]!) as Array<{ file: string }>;
    const reads = JSON.parse(/^Reads: (.*)$/m.exec(prompt)![1]!) as Array<{ file: string; text: string }>;
    return JSON.stringify(questions.map((question, i) => {
      const lines = reads.find((read) => read.file === question.file)?.text.split("\n").filter(Boolean) ?? [];
      return lines[i % lines.length] ?? null;
    }));
  }
  return null;
}

/** Engines that pass every quiz step, with one file question per filed topic; `changes` answers each propose call. */
export function sleepEngines(changes: (prompt: string) => unknown[] = () => []) {
  const keys = new Map<string, string | null>();
  const propose = async (prompt: string) => {
    const staged = sleepReply(prompt);
    if (staged !== null) return staged;
    if (prompt.startsWith("[memory-clean:questions]")) {
      const topics = JSON.parse(/Ask at least one such question for each of: (\[[^\]]*\])/.exec(prompt)?.[1] ?? "[]") as string[];
      const questions = Array.from({ length: 18 }, (_, i) => ({
        kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i < 16 ? `value ${i}` : null, ...(i < topics.length ? { file: topics[i], answer: topics[i] } : {}),
      }));
      for (const question of questions) keys.set(question.question, question.answer);
      return JSON.stringify(prompt.includes("\nRoute sources: ") ? { questions, routes: sleepRoutes(prompt) } : questions);
    }
    if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify((JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as unknown[]).map(() => true));
    return JSON.stringify({ version: 1, file: "MEMORY.md", changes: changes(prompt) });
  };
  const recall = async (prompt: string) => sleepReply(prompt) ?? JSON.stringify((JSON.parse(/^Questions: (.*)$/m.exec(prompt)![1]!) as string[]).map((question) => keys.get(question) ?? null));
  return { propose, recall };
}
