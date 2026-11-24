import { cn } from "@/lib/cn";
import { ROW_BUTTON } from "./SettingsPrimitives";

export type AccountAction = { label: string; run: () => void };

/** The one place a device signs its account in or out: top right of Settings > Account. */
export function AccountRow({ email, actions, error, busy, className }: {
  email: string;
  actions: AccountAction[];
  error?: string;
  busy?: boolean;
  className?: string;
}) {
  return (
    <div data-account-row className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        {email && <div className="min-w-0 truncate text-[13px] text-ink">{email}</div>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions.map((action) => (
            <button key={action.label} type="button" onClick={action.run} disabled={busy} className={ROW_BUTTON}>
              {action.label}
            </button>
          ))}
        </div>
      </div>
      {error && <div role="status" className="mt-2 text-[13px] text-ink-secondary">{error}</div>}
    </div>
  );
}
