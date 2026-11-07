/** What an honest answerer appends to Sleep's recall answers: each learned line supported, each removed line superseded. */
export function sleepVerdicts(prompt: string): string[] {
  const checks = /^Checks: (.*)$/m.exec(prompt)?.[1];
  return checks ? (JSON.parse(checks) as Array<{ quote?: string }>).map((check) => "quote" in check ? "supported" : "superseded") : [];
}
