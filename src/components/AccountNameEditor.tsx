import { useId, useRef, useState } from "react";
import { fetchResponse, responseBody } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import { holdReload } from "@/lib/reload-hold";
import { ROW_BUTTON } from "./SettingsPrimitives";

const ERRORS = {
  "too-long": "accounts.name.tooLong",
  "invalid-character": "accounts.name.invalidCharacter",
  taken: "accounts.name.taken",
  reserved: "accounts.name.reserved",
  "unknown-account": "accounts.name.unknownAccount",
} as const;

export type SavedAccountName = { id: string; number: number; nickname: string | null; name: string };

export function AccountNameEditor({ id, nickname, onSaved, onClose }: {
  id: string;
  nickname: string | null;
  onSaved: (account: SavedAccountName) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const field = useId();
  const [value, setValue] = useState(nickname ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const save = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetchResponse(`/api/accounts/${encodeURIComponent(id)}/name`, {
        method: "POST", body: JSON.stringify({ nickname: value.trim() || null }),
      });
      const body = await responseBody(response);
      if (!response.ok) {
        const code = Object.hasOwn(ERRORS, body.code) ? ERRORS[body.code as keyof typeof ERRORS] : "accounts.name.failed";
        setError(t(code));
        return;
      }
      onSaved(body);
      onClose();
    } catch { setError(t("accounts.name.failed")); }
    finally { pending.current = false; setBusy(false); }
  };
  return (
    <form data-account-name-editor="" className="flex min-w-0 flex-col gap-2 py-2" onSubmit={(event) => { event.preventDefault(); void holdReload(save()); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <label htmlFor={field}>{t("accounts.name.nickname")}</label>
      <input id={field} autoFocus value={value} onInput={(event) => setValue(event.currentTarget.value)} autoComplete="off" spellCheck={false}
        aria-describedby={error ? `${field}-error` : undefined} aria-invalid={Boolean(error)}
        className="h-9 min-w-0 rounded-[3px] border border-hairline bg-control px-2 text-[13px] text-ink [@media(pointer:coarse)]:h-11" />
      {error && <span id={`${field}-error`} role="alert" className="text-danger">{error}</span>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ROW_BUTTON}>{t("accounts.name.cancel")}</button>
        <button type="submit" disabled={busy} className={ROW_BUTTON}>{t("accounts.name.save")}</button>
      </div>
    </form>
  );
}
