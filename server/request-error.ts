export const unknownRoute = { code: "NOT_FOUND", error: "That page is no longer available. Refresh Wink and try again." };

export function requestError(cause: unknown, log: (message: string) => void = console.error) {
  log(cause instanceof Error ? cause.message : String(cause));
  const status = (cause as { status?: unknown } | null)?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
    const code = (cause as { code?: unknown }).code;
    return { status, body: { error: cause instanceof Error ? cause.message : String(cause), ...typeof code === "string" && { code } } };
  }
  return {
    status: typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    body: { code: "INTERNAL_ERROR", error: "Wink couldn't finish that. Try again." },
  };
}
