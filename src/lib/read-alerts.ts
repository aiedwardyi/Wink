// Phone alerts close once their chat is read, so the icon count the OS keeps from them drops too.
type ReadState = { id: string; unread?: boolean; readAt?: number };

/** Alert `at` and `readAt` are both server time, so a reply that lands after the read keeps its alert. */
export async function closeReadAlerts(readState: () => ReadonlyArray<ReadState> | Promise<ReadonlyArray<ReadState>>): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const alerts = (await registration?.getNotifications()) ?? [];
  if (!alerts.length) return;
  const readAt = new Map((await readState()).flatMap((chat) => (!chat.unread && chat.readAt !== undefined ? [[chat.id, chat.readAt] as const] : [])));
  for (const alert of alerts) {
    const read = readAt.get(alert.data?.chat);
    if (read !== undefined && (alert.data.at ?? 0) <= read) alert.close();
  }
}
