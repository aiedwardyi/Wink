import { useCallback, useEffect, useRef, useState } from "react";
import { ChartScatter, ChevronDown, ChevronLeft, ChevronRight, Coins, Keyboard, KeyRound, MonitorSmartphone, Palette, Settings, User, Users, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { detailedRepliesEnabled, showToolCallsEnabled } from "@/lib/feature-flags";
import {
  friendsSettingsNavVisible,
  resolvedAppSettingsSection,
} from "@/lib/settings-chrome";
import { SavedKeys } from "./ApiKeys";
import { updaterActions, useManualCheck, useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { ProfileFields } from "./ProfileFields";
import { Card, ROW_BUTTON } from "./SettingsPrimitives";
import { SegmentedRow } from "./Segmented";
import { useModelDialFits } from "./ModelDial";
import { UsageSection } from "./UsageSection";
import { QuorumRow, prefetchQuorum } from "./QuorumRow";
import { TeamSection, type TeamView } from "./TeamSection";
import { useTeamToday } from "@/lib/team-today";
import { useAutoRefresh } from "@/lib/usage-auto-refresh";
import { ModelIndexSection } from "./ModelIndexSection";
import { SkinPicker } from "./SkinPicker";
import { GeometryPicker } from "./GeometryPicker";
import { TerminalAppearanceRow } from "./TerminalAppearanceRow";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { LanguagePicker } from "./LanguagePicker";
import { CallVoicePicker } from "./CallVoicePicker";
import { useI18n } from "@/lib/i18n";
import { isTransientUpdateError } from "../../shared/update-error.mjs";
import { PhoneLinkSettings } from "./PhoneLinkSettings";
import { PhoneNotificationSettings } from "./PhoneNotificationSettings";
import { loadSidebarSide, saveSidebarSide, type SidebarSide } from "@/lib/sidebar-preferences";
import { isPhone, saveVibration, vibrationEnabled } from "@/lib/phone-swipe";
import { modelDialEnabled } from "@/lib/feature-flags";
import { saveModelPickerView, useModelPickerView, type ModelPickerView } from "@/lib/model-picker-view";
import { savePickerLook, usePickerLook, type PickerLook } from "@/lib/picker-look";
import { saveRainbowBox, useRainbowBox, type RainbowBox } from "@/lib/rainbow-box";
import { useSkin } from "@/lib/skins";
import { saveTerminalPopups, useTerminalPopups } from "@/lib/terminal-popups";
import { saveReplyStyle, useReplyStyle, type ReplyStyle } from "@/lib/reply-style";
import { cn } from "@/lib/cn";
import { showTerminalAlerts, showTerminalColors, showUsageStats } from "@/lib/friends-chrome";
import { useBackLayer } from "@/lib/use-back-layer";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { useSettingsSwipe } from "@/lib/use-settings-swipe";
import { SyncPanel } from "./SyncPanel";
import { StartFreshRow } from "./StartFreshRow";
import { ErrorReportsRow } from "./ErrorReportsRow";
import { AnalyticsRow } from "./AnalyticsRow";
import { Fold } from "./Fold";
import { ActivityCard } from "./ActivityCard";
import { RoomFilesFolderRow } from "./RoomFilesFolderRow";

const SECTIONS: Array<{
  id: AppSettingsSection;
  icon: typeof User;
  shortcut?: string;
}> = [
  { id: "account", icon: User },
  { id: "general", icon: Settings },
  { id: "connections", icon: KeyRound },
  { id: "usage", icon: Coins, shortcut: "Alt+U" },
  { id: "companion", icon: MonitorSmartphone },
  { id: "themes", icon: Palette, shortcut: "Alt+T" },
  { id: "team", icon: Users },
  { id: "models-index", icon: ChartScatter, shortcut: "Alt+I" },
  { id: "shortcuts", icon: Keyboard },
];

const SECTION_KEY = {
  account: "settings.section.account",
  general: "settings.section.general",
  connections: "settings.section.connections",
  themes: "settings.section.themes",
  shortcuts: "settings.section.shortcuts",
  companion: "settings.section.devices",
  usage: "settings.section.usage",
  team: "settings.section.team",
  "models-index": "settings.section.modelsIndex",
  sync: "settings.section.sync",
} as const;

function sectionNavVisible(
  section: (typeof SECTIONS)[number],
  phoneAvailable: boolean,
): boolean {
  return friendsSettingsNavVisible(section.id, { phoneAvailable });
}

function isMissingUpdateConfig(message?: string): boolean {
  if (!message) return false;
  return message.includes("app-update.yml") || message.includes("dev-app-update.yml");
}

export function UpdatesRow() {
  const { t } = useI18n();
  const s = useUpdaterState(true);
  const { acknowledged, check } = useManualCheck(s?.status ?? "idle");
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void window.ogb?.getAppVersion?.().then(setAppVersion, () => {});
  }, []);
  if (!window.ogb?.updater && !s) return null;
  const updater = updaterActions();
  const version = appVersion ?? s?.appVersion;
  const label =
    s?.status === "checking"
      ? t("settings.updates.checking")
      : s?.status === "available"
        ? t("settings.updates.available", { version: s.version ?? "" })
        : s?.status === "downloading"
          ? t("settings.updates.downloading", { percent: Math.round(s.percent ?? 0) })
          : s?.status === "downloaded"
            ? t("settings.updates.ready", { version: s.version ?? "" })
            : s?.status === "installing"
              ? t("update.restarting")
              : s?.status === "error"
                ? isMissingUpdateConfig(s.message)
                  ? t("settings.updates.unavailable")
                  : isTransientUpdateError(s.message)
                    ? t("update.unreachable")
                    : t("settings.updates.error")
                : acknowledged
                  ? t("update.upToDate")
                  : t("settings.updates.latest");
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.updates.title")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{version ? `v${version} · ` : ""}{label}</div>
        </div>
        <button
          onClick={() => {
            if (s?.status === "available") return void updater.download().catch(() => {});
            if (s?.status === "downloaded") return void updater.install().catch(() => {});
            check();
          }}
          disabled={s?.status === "checking" || s?.status === "downloading" || s?.status === "installing"}
          className={cn(ROW_BUTTON, "text-ink")}
        >
          {s?.status === "available"
            ? t("settings.updates.download")
            : s?.status === "downloaded"
              ? t("settings.updates.restart")
              : t("settings.updates.check")}
        </button>
      </div>
    </Card>
  );
}

function ToolCallsRow() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.toolCalls.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.toolCalls.toggle")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("settings.toolCalls.help")}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t("settings.toolCalls.aria")}
          disabled={saving}
          onClick={() => void toggle()}
          className={`${cnSwitch(enabled)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(enabled)} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}

function ReplyStyleRow() {
  const { t } = useI18n();
  const style = useReplyStyle();
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <SegmentedRow<ReplyStyle>
        label={t("settings.replyStyle.title")}
        value={style}
        options={(["paragraphs", "live"] as const).map((id) => ({ id, label: t(`settings.replyStyle.${id}`) }))}
        onChange={saveReplyStyle}
      />
    </div>
  );
}

function DetailedRepliesRow() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const enabled = detailedRepliesEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { detailedReplies: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.detailedReplies.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.detailedReplies.toggle")}</div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t("settings.detailedReplies.aria")}
          disabled={saving}
          onClick={() => void toggle()}
          className={`${cnSwitch(enabled)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(enabled)} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}

function SidebarSideRow() {
  const { t } = useI18n();
  const [side, setSide] = useState<SidebarSide>(() => loadSidebarSide());
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <SegmentedRow<SidebarSide>
        label={t("settings.sidebarSide.title")}
        value={side}
        options={(["left", "right"] as const).map((id) => ({ id, label: t(`settings.sidebarSide.${id}`) }))}
        onChange={(option) => { saveSidebarSide(option); setSide(option); }}
      />
    </div>
  );
}

function VibrationRow() {
  const { t } = useI18n();
  const [on, setOn] = useState(() => vibrationEnabled());
  if (!isPhone() || !window.navigator?.vibrate) return null;
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 text-[14px] font-medium text-ink">{t("settings.vibration.title")}</div>
        <button
          role="switch"
          aria-checked={on}
          aria-label={t("settings.vibration.aria")}
          onClick={() => { saveVibration(!on); setOn(!on); }}
          className={cnSwitch(on)}
        >
          <span className={cnKnob(on)} />
        </button>
      </div>
    </Card>
  );
}

function NotificationsRow() {
  const { t } = useI18n();
  const on = useTerminalPopups();
  return (
    <Card title={t("settings.notifications.title")}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.notifications.terminal")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("settings.notifications.terminalHelp")}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={on}
          aria-label={t("settings.notifications.terminal")}
          onClick={() => saveTerminalPopups(!on)}
          className={cnSwitch(on)}
        >
          <span className={cnKnob(on)} />
        </button>
      </div>
    </Card>
  );
}

function RainbowBoxRow() {
  const { t } = useI18n();
  const box = useRainbowBox();
  return (
    <Card>
      <SegmentedRow<RainbowBox>
        label={t("settings.rainbowBox.title")}
        hint={t("settings.rainbowBox.help")}
        value={box}
        options={(["off", "rainbow", "theme"] as const).map((id) => ({ id, label: t(`settings.rainbowBox.${id}`) }))}
        onChange={saveRainbowBox}
      />
    </Card>
  );
}

function PickerLookRow() {
  const { t } = useI18n();
  const look = usePickerLook(useSkin());
  return (
    <Card>
      <SegmentedRow<PickerLook>
        label={t("settings.pickerLook.title")}
        value={look}
        options={(["dark", "light", "atelier"] as const).map((id) => ({ id, label: t(`settings.pickerLook.${id}`) }))}
        onChange={savePickerLook}
      />
    </Card>
  );
}

function PickerStyleRow() {
  const { t } = useI18n();
  const { state } = useStore();
  const view = useModelPickerView();
  if (!useModelDialFits(modelDialEnabled(state.config))) return null;
  return (
    <Card>
      <SegmentedRow<ModelPickerView>
        label={t("settings.pickerStyle.title")}
        value={view}
        options={(["dial", "list"] as const).map((id) => ({ id, label: t(`settings.pickerStyle.${id}`) }))}
        onChange={saveModelPickerView}
      />
    </Card>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

/** Writes a redacted diagnostics file to a location the user picks. The
 * report holds versions, configured-or-not booleans and the server.log tail —
 * never credential values (the desktop shell does not read secret fields). */
export function DiagnosticsRow() {
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const exportDiagnostics = async () => {
    if (!window.ogb?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.ogb.exportDiagnostics();
      if (path) setResult({ kind: "success", message: t("settings.diagnostics.saved", { path }) });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title={t("settings.diagnostics.title")}
      subtitle={t("settings.diagnostics.subtitle")}
    >
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label={t("settings.diagnostics.exportAria")}
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? t("settings.diagnostics.exporting") : t("settings.diagnostics.export")}
        </button>
        {result ? (
          <span
            role={result.kind === "error" ? "alert" : "status"}
            className={`max-w-64 break-all text-right text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function SettingsModal({
  closing = false,
  defaultAdvancedOpen = false,
}: {
  closing?: boolean;
  /** Start with Advanced expanded (tests). */
  defaultAdvancedOpen?: boolean;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const section = resolvedAppSettingsSection(state.appSettingsSection);
  const phone = useIsPhone();
  useAutoRefresh();
  const page = !phone || state.appSettingsPage;
  const back = useCallback(() => {
    dispatch({ type: "toggleAppSettings", open: phone && page });
  }, [dispatch, phone, page]);
  const backRef = useRef(back);
  useEffect(() => { backRef.current = back; }, [back]);
  useBackLayer(!closing && phone && page, back);
  const dialogRef = useRef<HTMLDivElement>(null);
  const activityWaved = useRef(false);
  useSettingsSwipe(dialogRef, phone && !closing, phone && page ? section : false, back);
  const [preferencesOpen, setPreferencesOpen] = useState(defaultAdvancedOpen);
  const phoneAvailable = true;
  const [teamOwner, setTeamOwner] = useState(false);
  const [teamStats, setTeamStats] = useState<TeamView | null>(null);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const teamToday = useTeamToday(teamOwner && !closing, accountEmail);
  const sectionShown = useCallback(
    (entry: (typeof SECTIONS)[number]) => (entry.id !== "team" || teamOwner) && (!phone || entry.id !== "shortcuts") && sectionNavVisible(entry, phoneAvailable),
    [phoneAvailable, teamOwner, phone],
  );
  const visibleSections = SECTIONS.filter(sectionShown);

  useEffect(() => {
    if (!closing && teamOwner) prefetchQuorum();
  }, [closing, teamOwner]);

  useEffect(() => {
    if (closing) return;
    let gone = false;
    void (async () => {
      try {
        const account = await api("/api/google-account");
        const email = account?.state === "signed-in" && account.email ? String(account.email) : "";
        if (!email) throw new Error("session");
        const body = await api("/api/team");
        const people = body?.people;
        const days = body?.days;
        const now = Number(body?.now);
        if (!Array.isArray(people) || !Array.isArray(days) || !Number.isFinite(now)) throw new Error("team");
        if (gone) return;
        setTeamOwner(true);
        setTeamStats({ now, days, people });
      } catch {
        if (gone) return;
        setTeamOwner(false);
        setTeamStats(null);
      }
    })();
    return () => {
      gone = true;
    };
  }, [accountEmail, closing]);

  useEffect(() => {
    if (closing) return;
    const visible = SECTIONS.filter(sectionShown);
    if (visible.some((entry) => entry.id === section)) return;
    const first = visible[0];
    if (first) dispatch(phone ? { type: "toggleAppSettings", open: true } : { type: "toggleAppSettings", open: true, section: first.id });
  }, [closing, dispatch, phone, section, sectionShown]);

  useEffect(() => {
    if (closing) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && !dialog?.contains(event.target) && event.target.closest('[aria-modal="true"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        backRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.closest("[inert]"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [closing, dispatch]);

  useEffect(() => {
    if (phone && !closing) dialogRef.current?.focus();
  }, [phone, page, closing]);

  return (
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 max-md:bg-transparent"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      {phone && <div data-settings-scrim className="pointer-events-none absolute inset-0 bg-black/50" />}
      <div
        ref={dialogRef}
        role={closing ? undefined : "dialog"}
        aria-modal={!closing || undefined}
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        // h-* alone overflows the 600x480 window floor above and below; max-h-full
        // hands the excess to the content pane, which is the only thing that scrolls.
        className={cn(
          "animate-pop-in flex max-h-full w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none max-md:relative max-md:flex-col",
          "h-[560px]",
        )}
      >
        {phone && (
          <div data-settings-underlay className={cn("flex min-h-0 min-w-0 flex-1 flex-col", page && "absolute inset-0")}>
          <nav data-settings-list aria-hidden={page || undefined} inert={page} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between px-5 py-3">
              <span id={!page ? "app-settings-title" : undefined} className="text-[17px] font-semibold text-ink">{t("settings.title")}</span>
              <button onClick={() => dispatch({ type: "toggleAppSettings", open: false })} aria-label={!page ? t("settings.close") : undefined} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-5">
              <div className="overflow-hidden rounded-xl bg-card">
                {visibleSections.map(({ id, icon: Icon }) => (
                  <button key={id} aria-label={t(SECTION_KEY[id])} onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })} className="flex min-h-[50px] w-full items-center gap-3 border-t border-hairline/40 px-4 text-left first:border-t-0 hover:bg-control">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary"><Icon size={15} /></span>
                    <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{t(SECTION_KEY[id])}</span>
                    <ChevronRight size={16} className="shrink-0 text-ink-secondary" />
                  </button>
                ))}
              </div>
            </div>
          </nav>
          </div>
        )}
        {!phone && (
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3 max-md:w-full max-md:border-r-0 max-md:border-b max-md:p-2">
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink max-md:hidden">
            {t("settings.title")}
          </div>

          <div className="flex flex-col gap-0.5 max-md:flex-row max-md:justify-between max-md:gap-1 max-md:overflow-x-auto">
            {visibleSections.map(({ id, icon: Icon, shortcut }) => (
              <button
                key={id}
                onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
                aria-current={section === id ? "page" : undefined}
                aria-keyshortcuts={shortcut}
                aria-label={t(SECTION_KEY[id])}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] max-md:shrink-0",
                  section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                )}
              >
                <Icon size={15} />
                <span className="-mr-1.5 min-w-0 flex-1 truncate max-md:hidden">{t(SECTION_KEY[id])}</span>

              </button>
            ))}
          </div>
        </nav>
        )}

        {page && (
        <div data-settings-page={phone ? section : undefined} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", phone && "relative bg-panel")}>
          <div className={phone ? "relative flex shrink-0 items-center gap-3 px-2 py-3" : "flex shrink-0 items-center justify-between px-5 py-3 gap-3"}>
            {phone && (
              <button onClick={back} aria-label={t("settings.sync.back")} className="flex min-h-11 items-center gap-0.5 rounded-md px-1.5 text-[15px] text-accent hover:bg-control">
                <ChevronLeft size={20} />{t("settings.title")}
              </button>
            )}
            <span id={phone ? "app-settings-title" : undefined} className={cn("text-[15px] font-semibold text-ink", phone && "pointer-events-none absolute left-1/2 -translate-x-1/2")}>
              {t(SECTION_KEY[section])}
            </span>
            <div className="ml-auto flex items-center gap-3">
              {!phone && section === "themes" && <GeometryPicker />}
              <button
                onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
                aria-label={t("settings.close")}
                className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          {phone && section === "themes" && <div className="flex justify-end px-5 pb-3"><GeometryPicker /></div>}

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "account" && (
              <>
                <Card>
                  <div className="flex items-center gap-6">
                    <div className="min-w-0 flex-1 md:min-w-[13rem] lg:min-w-[19rem]"><ProfileFields /></div>
                    {!phone && (
                      <div className="min-w-0 self-stretch border-l border-hairline/40 pl-6">
                        <SyncPanel onAccountEmail={setAccountEmail} />
                      </div>
                    )}
                  </div>
                </Card>
                <ActivityCard waved={activityWaved} />
              </>
            )}

            {section === "companion" && <PhoneLinkSettings />}

            {section === "general" && (
              <>
                <LanguagePicker />
                <CallVoicePicker />
                {!window.ogb && <Card><PhoneNotificationSettings /></Card>}
                <VibrationRow />
                <UpdatesRow />
                <RoomFilesFolderRow />
                <ErrorReportsRow />
                {showUsageStats() && <AnalyticsRow />}
                <button
                  type="button"
                  aria-expanded={preferencesOpen}
                  onClick={() => setPreferencesOpen((open) => !open)}
                  className="flex w-full items-center justify-between rounded-xl border border-hairline/40 bg-card px-4 py-3 text-left hover:bg-control/60"
                >
                  <span className="text-[14px] font-medium text-ink">{t("settings.advanced.title")}</span>
                  <ChevronDown
                    size={16}
                    className={cn("text-ink-secondary transition-transform", preferencesOpen && "rotate-180")}
                  />
                </button>
                <Fold open={preferencesOpen} className="-mt-4">
                  <div data-settings-preferences className="pt-4">
                    <Card>
                      <div className="divide-y divide-hairline/40">
                        <SidebarSideRow />
                        <ReplyStyleRow />
                        {showTerminalColors() && <TerminalAppearanceRow />}
                        <ToolCallsRow />
                        <DetailedRepliesRow />
                        {showTerminalAlerts() && <NotificationsRow />}
                      </div>
                      <StartFreshRow />
                    </Card>
                  </div>
                </Fold>
              </>
            )}

            {section === "connections" && (
              <div data-settings-connections="" className="flex flex-col gap-4">
                <EnginesSettings />
                <SavedKeys />
              </div>
            )}

            {section === "themes" && (
              <>
                <RainbowBoxRow />
                <PickerLookRow />
                <PickerStyleRow />
                <Card>
                  <SkinPicker />
                </Card>
              </>
            )}


            {section === "usage" && <UsageSection />}
            {section === "team" && teamStats && (
              <>
                <TeamSection stats={teamStats} today={teamToday} />
                <QuorumRow />
              </>
            )}
            {section === "models-index" && <ModelIndexSection />}
            {section === "shortcuts" && <KeyboardShortcuts />}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
