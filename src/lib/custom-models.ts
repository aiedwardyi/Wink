// Custom picker: search the live inject list.

export function filterCustomModels<T extends { id: string; label: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter(
    (option) => option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle),
  );
}
