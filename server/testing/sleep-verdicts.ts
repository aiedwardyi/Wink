import { factParts } from "../memory-clean-coverage.ts";

export function sleepReply(prompt: string): string | null {
  if (prompt.startsWith("[memory-clean:organize]")) {
    const checks = JSON.parse(/^Checks: (.*)$/m.exec(prompt)![1]!) as unknown[];
    return JSON.stringify({ verdicts: checks.map(() => true), corrections: [] });
  }
  if (prompt.startsWith("[memory-clean:route-questions]")) {
    const sources = JSON.parse(/^Sources: (.*)$/m.exec(prompt)![1]!) as Array<{ id: number; text: string }>;
    return JSON.stringify(sources.flatMap(({ id, text }) => factParts(text).map((fact, index) => {
      const label = fact.replace(/[a-z]{40,}/gi, "").trim();
      return { id, fact, label, question: `Which file holds source ${id} part ${index}: ${label}?`, valueQuestion: `What is recorded for source ${id} part ${index}?`, answer: fact };
    })));
  }
  if (prompt.startsWith("[memory-clean:routes]")) {
    const questions = JSON.parse(/^Questions: (.*)$/m.exec(prompt)![1]!) as string[];
    const index = prompt.slice(prompt.indexOf("MEMORY.md:\n"));
    const path = /memory\/(?!memory-history)[\w.-]+\.md/.exec(index)?.[0] ?? null;
    return JSON.stringify(questions.map(() => path));
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
