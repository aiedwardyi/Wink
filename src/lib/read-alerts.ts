// Phone alerts close once their chat is read, so the icon count the OS keeps from them drops too.
export async function closeReadAlerts(unreadBefore: ReadonlySet<string>, unreadNow: ReadonlySet<string>): Promise<void> {
  const read = new Set([...unreadBefore].filter((id) => !unreadNow.has(id)));
  if (!read.size) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  for (const alert of (await registration?.getNotifications()) ?? []) if (read.has(alert.data?.chat)) alert.close();
}
