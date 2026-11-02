// Double-click a title to rename it in place. Settings still exists for
// the rest of the profile - this is just the fast path for the name.
import { useEffect, useState } from "react";

import { nextRename } from "@/lib/rename";
import { cn } from "@/lib/cn";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { useI18n } from "@/lib/i18n";

export function RenameTitle({
  value,
  onCommit,
  editing: controlledEditing,
  onEditingChange,
  onActivate,
  className,
  inputClassName,
}: {
  value: string;
  onCommit: (next: string) => void;
  /** Parent-owned editing state; survives a remount when the parent swaps wrappers. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Optional single-click action for locations where the title opens a profile. */
  onActivate?: () => void;
  className?: string;
  inputClassName?: string;
}) {
  const { t } = useI18n();
  const [localEditing, setEditing] = useState(false);
  const editing = controlledEditing ?? localEditing;
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const setMode = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };

  const finish = (save: boolean) => {
    const next = save ? nextRename(value, draft) : null;
    setMode(false);
    if (next) onCommit(next);
    else setDraft(value);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={BOT_PROFILE_LIMITS.name}
        aria-label={t("rename.aria")}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        className={cn("min-w-0 bg-transparent text-ink focus:outline-none", inputClassName)}
      />
    );
  }

  const startRename = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    setDraft(value);
    setMode(true);
  };

  if (onActivate) {
    return (
      <span className="flex min-w-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onActivate}
          aria-label={t("chat.openProfile", { name: value })}
          className={cn("min-w-0 truncate text-left", className)}
          title={t("rename.openProfile")}
        >
          {value}
        </button>
      </span>
    );
  }

  return (
    <span
      className={cn("cursor-text", className)}
      title={t("rename.doubleClick")}
      tabIndex={0}
      role="button"
      aria-label={t("rename.named", { name: value })}
      onDoubleClick={startRename}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          startRename(event);
        }
      }}
    >
      {value}
    </span>
  );
}
