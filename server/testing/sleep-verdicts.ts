export function sleepReply(prompt: string): string | null {
  if (prompt.startsWith("[memory-clean:organize]")) {
    const checks = JSON.parse(/^Checks: (.*)$/m.exec(prompt)![1]!) as unknown[];
    return JSON.stringify({ verdicts: checks.map(() => true), corrections: [] });
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
      return JSON.stringify(questions);
    }
    if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify((JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as unknown[]).map(() => true));
    return JSON.stringify({ version: 1, file: "MEMORY.md", changes: changes(prompt) });
  };
  const recall = async (prompt: string) => sleepReply(prompt) ?? JSON.stringify((JSON.parse(/^Questions: (.*)$/m.exec(prompt)![1]!) as string[]).map((question) => keys.get(question) ?? null));
  return { propose, recall };
}
