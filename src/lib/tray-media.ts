// The picked picture or clip behind each tray chip, by chip id, so the tray previews it from memory on every device; a reload forgets them.
const kept = new Map<string, Blob>();

export function keepTrayMedia(id: string, file: Blob): void {
  if (/^(image|video)\//.test(file.type)) kept.set(id, file);
}

export const trayMedia = (id: string): Blob | undefined => kept.get(id);
