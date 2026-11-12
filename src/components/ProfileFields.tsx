import { fallbackError } from "@/lib/error-text";
import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { showAvatarFormatsHint } from "@/lib/friends-chrome";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";
import { InitialsAvatar, profileInitials } from "./Avatar";

/** Photo and name. The name persists only when Save is pressed. */
export function ProfileFields() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const savedName = state.config?.profile?.name ?? "";
  const [name, setName] = useState(savedName);
  const [shownName, setShownName] = useState(savedName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [rejected, setRejected] = useState(false);
  const avatarUrl = state.config?.profile?.avatarUrl;
  // Null until the first config answer: a placeholder, never an empty name or a "?" photo.
  const loaded = state.config !== null;
  // Synced during render, not in an effect, so the frame the profile arrives already has the name.
  if (shownName !== savedName) {
    setShownName(savedName);
    setName(savedName);
  }

  const send = async (request: () => Promise<ConfigStatus>, fallback: MessageKey) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      dispatch({ type: "configStatus", config: await request() });
    } catch (cause) {
      setError(fallbackError(cause, t(fallback)));
    } finally {
      setSaving(false);
    }
  };

  const put = (profile: () => Promise<{ name?: string; avatarUrl?: string }>, fallback: MessageKey) =>
    send(
      async () =>
        api("/api/config", {
          method: "PUT",
          body: JSON.stringify({ profile: await profile() }),
        }),
      fallback,
    );

  // A blank Save with no stored name would mark the name cleared and block the Google fill.
  const save = () =>
    name.trim() || state.config?.profile?.name?.trim() ? put(async () => ({ name: name.trim() }), "settings.profile.saveError") : undefined;

  const changePhoto = async (file: File | undefined) => {
    if (!file) return;
    setRejected(false);
    await put(async () => {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) {
        setRejected(true);
        throw new Error(t("bot.avatarWrongType"));
      }
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error(t("bot.avatarUnusable"));
      return { avatarUrl };
    }, "settings.profile.photoError");
    if (fileRef.current) fileRef.current.value = "";
  };

  const googlePhoto = () =>
    send(
      () =>
        api("/api/profile/google-photo", { method: "POST" }).catch(() => {
          throw new Error(t("settings.profile.photoError"));
        }),
      "settings.profile.photoError",
    );

  const inputClass =
    "w-full md:max-w-xs rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-wait disabled:opacity-50";
  const buttonClass =
    "whitespace-nowrap rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:cursor-wait disabled:opacity-50";
  const quietButtonClass =
    "whitespace-nowrap rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-wait disabled:opacity-50";
  return (
    <div className="flex flex-col gap-2">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void changePhoto(event.target.files?.[0])}
      />
      <div className="flex items-center gap-4 max-md:flex-col max-md:gap-3">
        <InitialsAvatar initials={profileInitials(state.config?.profile)} imageUrl={avatarUrl} size={56} pending={!loaded} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 max-md:w-full max-md:flex-col-reverse max-md:gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="settings-profile-name" className="sr-only">{t("settings.profile.nameLabel")}</label>
            <input
              id="settings-profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={loaded ? t("settings.profile.namePlaceholder") : undefined}
              disabled={saving || !loaded}
              className={`min-w-0 flex-1 ${inputClass} ${loaded ? "" : "animate-pulse motion-reduce:animate-none"}`}
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !loaded}
              aria-label={t("settings.profile.saveAria")}
              className={`self-start ${buttonClass}`}
            >
              {t("settings.profile.save")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1 max-md:justify-center">
            <button type="button" onClick={() => fileRef.current?.click()} disabled={saving || !loaded} className={buttonClass}>
              {t("settings.profile.changePhoto")}
            </button>
            {state.config?.profile?.googlePhoto ? (
              <button type="button" onClick={() => void googlePhoto()} disabled={saving} className={quietButtonClass}>
                {t("settings.profile.googlePhoto")}
              </button>
            ) : null}
            {avatarUrl ? (
              <button
                type="button"
                onClick={() => void put(async () => ({ avatarUrl: "" }), "settings.profile.photoError")}
                disabled={saving}
                className={quietButtonClass}
              >
                {t("settings.profile.removePhoto")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {(showAvatarFormatsHint() || rejected) && <p className="text-[11.5px] text-ink-secondary">{t("bot.avatarFormats")}</p>}
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
