import { useRef, useState, type ReactNode } from "react";

import { useI18n } from "@/lib/i18n";
import { linkedFolder, showFolder } from "@/lib/show-pane";

/** A folder link on a PC without the folder: shows the PC's copy in the pane, or says it opens on the desktop. */
export function LinkedFolderLink({ folderPath, threadId, children }: { folderPath: string; threadId: string; children?: ReactNode }) {
  const { t } = useI18n();
  const [refused, setRefused] = useState(false);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const open = async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    const listing = await linkedFolder(threadId, folderPath);
    busy.current = false;
    setLoading(false);
    setRefused(!listing);
    if (listing) showFolder(threadId, folderPath, listing);
  };
  return (
    <>
      <button type="button" onClick={() => void open()} aria-busy={loading || undefined} title={folderPath} className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent">
        {children}
      </button>
      {refused && <span className="ml-1.5 text-[12px] text-ink-secondary">{t("chat.fileLink.desktopOnly")}</span>}
    </>
  );
}
