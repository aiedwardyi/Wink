import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { onThisPc } from "@/lib/devices-setup";
import { localeTag, useI18n, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { DeviceRow, DevicesSection, PendingRow } from "./DeviceRows";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { trackFeature, trackSetting } from "@/lib/usage-stats";

type RelayState = "off" | "enrolling" | "certifying" | "connected" | "reconnecting" | "rejected" | "cert-error";
type RelayProblem = "superseded" | "revoked" | "ticket-expired" | "unknown-certificate";

export interface RelayStatus {
  /** False when ORBIT_RELAY=0; absent from a PC that takes no setup codes. */
  available?: boolean;
  configured: boolean;
  /** The configured relay base domain. */
  base?: string | null;
  enabled: boolean;
  state: RelayState;
  host: string | null;
  relayRttMs: number | null;
  certNotAfter: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
  problem: RelayProblem | null;
}

interface Phone {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

const STATUS_POLL_MS = 3_000;
// The sign-in page lists only PCs on its own relay base.
const FRONT_DOOR = "wink.edwardyi.dev";

const PROBLEM = {
  superseded: "settings.phoneAccess.problem.superseded",
  revoked: "settings.phoneAccess.problem.revoked",
  "ticket-expired": "settings.phoneAccess.problem.ticketExpired",
  "unknown-certificate": "settings.phoneAccess.problem.unknownCertificate",
} satisfies Record<RelayProblem, MessageKey>;

// What the PC answers a refused setup code with. Any other error is the PC's own words.
const REFUSED = new Map<string, MessageKey>([
  ["invite-used", "settings.phoneAccess.setup.used"],
  ["invite-expired", "settings.phoneAccess.setup.expired"],
  ["enroll-failed", "settings.phoneAccess.setup.failed"],
]);

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;
const button = "rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70 disabled:cursor-not-allowed disabled:opacity-50";
const input = "min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent";
const note = "mt-2 break-words text-[12px] leading-relaxed text-ink-secondary";

type Google = { state: string; email?: string };
type Saved = { status: RelayStatus | null; google: Google | null; phones: Phone[] | null };
const KEY = "omb-phone-relay";
let last: Saved | null = null;
let pending: Promise<unknown> | null = null;

function saved(): Saved {
  if (last) return last;
  last = { status: null, google: null, phones: null };
  try {
    const body = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof body?.status?.enabled === "boolean") last = { status: body.status, google: body.google ?? null, phones: Array.isArray(body.phones) ? body.phones : null };
  } catch {
    /* A fresh fetch fills it in. */
  }
  return last;
}

function keep(next: Partial<Saved>) {
  last = { ...saved(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(last));
  } catch {
    /* It still paints from memory this session. */
  }
}

/** This PC's relay, Google state and signed-in phones, fetched at idle so Devices paints them on its first open. */
export function warmRelay(): Promise<unknown> {
  if (!onThisPc()) return Promise.resolve();
  pending ??= Promise.all([
    api("/api/phone-relay/status").then((status: RelayStatus) => keep({ status }), () => {}),
    api("/api/google-account").then((google: Google) => keep({ google }), () => {}),
    api("/api/phone/devices").then((body: { phones: Phone[] }) => keep({ phones: body.phones }), () => {}),
  ]).finally(() => { pending = null; });
  return pending;
}

/** Tests only: forget the last state. */
export function resetRelay(): void {
  last = null;
  pending = null;
}

/** This PC's relay switch, its link and the devices signed in to it, with `pcs` between. `refresh` reloads that list. With no relay set up, the switch calls `onNoRelay`. */
export function PhoneAccessSettings({ request = api, refresh = 0, onEnabled, onNoRelay, pcs }: { request?: typeof api; refresh?: number; onEnabled?: (on: boolean) => void; onNoRelay: () => void; pcs?: ReactNode }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<RelayStatus | null>(() => saved().status);
  const [refused, setRefused] = useState(false);
  const [google, setGoogle] = useState<Google | null>(() => saved().google);
  const [phones, setPhones] = useState<Phone[] | null>(() => saved().phones);
  const [now, setNow] = useState(() => Date.now());
  const [asking, setAsking] = useState(false);
  const [invite, setInvite] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  const loadGoogle = useCallback(
    () => request("/api/google-account").then((body: Google) => {
      keep({ google: body });
      setGoogle(body);
    }, () => {}),
    [request],
  );

  useEffect(() => {
    let live = true;
    const load = () =>
      request("/api/phone-relay/status")
        .then((body: RelayStatus) => {
          if (!live) return;
          keep({ status: body });
          setStatus(body);
          setRefused(false);
          setNow(Date.now());
        })
        .catch(() => {
          if (live) setRefused(true);
        });
    void load();
    void loadGoogle();
    const timer = window.setInterval(load, STATUS_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.clearTimeout(copiedTimer.current);
    };
  }, [request, loadGoogle]);

  const enabled = status?.enabled === true;
  useEffect(() => onEnabled?.(enabled), [enabled, onEnabled]);
  useEffect(() => {
    if (!enabled) return;
    const load = () => void request("/api/phone/devices").then((body: { phones: Phone[] }) => {
      keep({ phones: body.phones });
      setPhones(body.phones);
    }, () => {});
    load();
    const timer = window.setInterval(load, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh, request]);

  // While a retry is scheduled: tick its countdown.
  const retrying = status?.state === "reconnecting" && status.nextRetryAt !== null;
  useEffect(() => {
    if (!retrying) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [retrying]);

  // Unknown until the first answer: the row paints at once, a placeholder where the switch goes, never a false Off.
  const known = status !== null || refused;

  const run = async (work: () => Promise<void>, failure: (cause: unknown) => string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = (on: boolean) =>
    run(
      async () => {
        setStatus(await request("/api/phone-relay", { method: "PUT", body: JSON.stringify({ enabled: on }) }));
        trackSetting("phoneAccess", on ? "off" : "on", on ? "on" : "off");
      },
      () => t("settings.phoneAccess.saveError"),
    );
  const setupError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    const known = REFUSED.get(message);
    return known ? t(known) : t("settings.phoneAccess.setup.error", { message });
  };
  const join = () =>
    run(
      async () => {
        setStatus(await request("/api/phone-relay/enroll", { method: "POST", body: JSON.stringify({ invite: invite.trim() }) }));
        setInvite("");
      },
      setupError,
    );
  const setUp = () =>
    run(
      async () => {
        setStatus(await request("/api/phone-relay/setup", { method: "POST", body: JSON.stringify({ code: code.trim() }) }));
        setCode("");
      },
      setupError,
    );
  const remove = (phone: Phone) =>
    run(
      async () => {
        await request(`/api/phone/devices/${encodeURIComponent(phone.id)}`, { method: "DELETE" });
        keep({ phones: saved().phones?.filter((candidate) => candidate.id !== phone.id) ?? null });
        setPhones((list) => list && list.filter((candidate) => candidate.id !== phone.id));
        trackFeature("phone.unpair");
      },
      () => t("settings.phoneAccess.removeError"),
    );
  const signIn = async () => {
    const result = await window.ogb?.googleAccount?.signIn().catch(() => null);
    if (result?.ok) await loadGoogle();
  };
  const configured = status?.configured === true;
  const confirm = () => {
    setAsking(false);
    void save(true);
  };
  const link = status?.host ? `https://${status.host}/` : null;
  const door = status?.host?.endsWith(`.${FRONT_DOOR}`) === true;
  const shown = door ? FRONT_DOOR : status?.host?.replace(/^(.{4}).{12}\./, "$1….");
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(door ? `https://${FRONT_DOOR}/` : link);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const codeField = (value: string, change: (value: string) => void) => (
    <input
      value={value}
      onChange={(event) => {
        change(event.target.value);
        setError(null);
      }}
      aria-label={t("settings.phoneAccess.setup.code")}
      placeholder={locale === "en" ? "Setup code" : t("settings.phoneAccess.setup.code")}
      autoComplete="off"
      spellCheck={false}
      className={input}
    />
  );
  const codeForm = (value: string, change: (value: string) => void, submit: () => void) => (
    <form
      data-phone-access-setup
      className="mt-2 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) submit();
      }}
    >
      {codeField(value, change)}
      <button type="submit" disabled={busy || !value.trim()} className={button}>
        {t("settings.phoneAccess.setup.submit")}
      </button>
    </form>
  );

  const signedOut = known && google !== null && ["signed-out", "needs-sign-in"].includes(google.state);
  const unavailable = known && ((refused && !status) || status?.available === false || (!configured && status?.available !== true));
  const toggle = (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={t("settings.devices.reach")}
      disabled={busy || (!enabled && unavailable)}
      onClick={() => {
        if (enabled) return void save(false);
        // No relay: no one sent a setup code, so go to the other ways to connect.
        if (!configured) return void onNoRelay();
        setAsking(true);
      }}
      className={cnSwitch(enabled)}
    >
      <span className={cnKnob(enabled)} />
    </button>
  );
  const signInButton = window.ogb?.googleAccount ? (
    <button type="button" onClick={() => void signIn()} className={ROW_BUTTON}>
      {t("settings.devices.signIn")}
    </button>
  ) : null;
  // Already on: keep the switch so turning it off never needs a sign-in.
  const control = !known
    ? <span data-switch-pending="" aria-hidden="true" className="h-6 w-11 shrink-0 animate-pulse rounded-full bg-control motion-reduce:animate-none" />
    : enabled || unavailable || !signedOut ? toggle : (signInButton ?? toggle);
  const sub = enabled ? google?.email : unavailable ? t("settings.devices.reachUnavailable") : signedOut ? t("settings.devices.reachSignIn") : google?.email;

  const tag = localeTag(locale);
  const day = (ms: number) => new Date(ms).toLocaleDateString(tag, { month: "short", day: "numeric" });
  const retryIn = status?.nextRetryAt ? Math.max(1, Math.ceil((status.nextRetryAt - now) / 1000)) : null;
  const state = status?.state ?? "off";
  const stateText =
    state === "reconnecting"
      ? retryIn
        ? t("settings.phoneAccess.state.retrying", { seconds: retryIn })
        : t("settings.phoneAccess.state.connecting")
      : state === "cert-error"
        ? t("settings.phoneAccess.state.certError")
        : state === "enrolling"
          ? t("settings.phoneAccess.setup.help")
          : t(`settings.phoneAccess.state.${state}`);
  const connected = enabled && state === "connected";
  const needsInvite = enabled && (state === "enrolling" || status?.problem === "revoked" || status?.problem === "ticket-expired");
  // Off with an error: the relay client failed to load or start.
  const failed = enabled && state === "off" && status?.lastError !== null;

  return (
    <>
      <DevicesSection
        title={t("settings.devices.thisPc")}
        data-this-pc=""
        after={<>
          {enabled && !connected ? <p data-phone-access-state={state} className={note}>{stateText}</p> : null}
          {enabled && !status?.problem && status?.lastError ? (
            <p data-phone-access-error className={note}>
              {connected ? t("settings.phoneAccess.renewalError", { message: status.lastError }) : status.lastError}
            </p>
          ) : null}
          {enabled && status?.problem ? (
            <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] leading-relaxed text-danger">
              {t(PROBLEM[status.problem])}
            </div>
          ) : null}
          {failed ? codeForm(code, setCode, () => void setUp()) : null}
          {needsInvite ? codeForm(invite, setInvite, () => void join()) : null}
          {error && !asking ? <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p> : null}
        </>}
      >
        <DeviceRow name={t("settings.devices.reach")} sub={sub} control={control} />
        {enabled && link ? (
          <div data-account-row="" className="min-w-0 border-hairline/70 [&+&]:border-t">
            <div className="flex items-start gap-4">
              <div data-relay-qr data-url={link} className="shrink-0 rounded-lg bg-white p-2 max-[379px]:[&>svg]:size-[88px]" aria-label={t("settings.devices.openAnywhere")}>
                <QRCodeSVG value={link} size={104} level="M" bgColor="#ffffff" fgColor="#111111" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium leading-[18px] text-ink">{t("settings.devices.openAnywhere")}</div>
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <span data-relay-link="" className="min-w-0 truncate text-[13px] text-ink">{shown}</span>
                  <button type="button" onClick={() => void copy()} className={cn(ROW_BUTTON, "gap-1.5")}>
                    {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                    {copied ? t("settings.phoneLink.copied") : t("settings.phoneLink.copy")}
                  </button>
                </div>
                <div className="mt-1.5 break-keep text-[11px] leading-[1.35] text-ink-secondary">{t("settings.devices.openAnywhereHelp")}</div>
              </div>
            </div>
          </div>
        ) : null}
      </DevicesSection>

      {pcs}

      {enabled ? (
        <DevicesSection title={t("settings.devices.signedInHere")} data-signed-in="">
          {!phones ? <PendingRow sub /> : phones.length ? phones.map((phone) => (
            <DeviceRow
              key={phone.id}
              name={phone.name}
              sub={t("settings.phoneAccess.phoneMeta", { paired: day(phone.createdAt), seen: day(phone.lastSeenAt) })}
              control={
                <button type="button" disabled={busy} onClick={() => void remove(phone)} aria-label={t("settings.phoneAccess.removeAria", { name: phone.name })} className={ROW_BUTTON}>
                  {t("settings.phoneAccess.remove")}
                </button>
              }
            />
          )) : <DeviceRow name={t("settings.devices.noneSignedIn")} />}
        </DevicesSection>
      ) : null}

      {asking ? (
        <ConfirmDialog
          title={t("settings.devices.reachConfirm")}
          body={t("settings.devices.reachConfirmBody")}
          confirmLabel={t("settings.devices.turnOn")}
          cancelLabel={t("settings.phoneAccess.cancel")}
          danger={false}
          confirmDisabled={busy}
          onConfirm={confirm}
          onCancel={() => {
            setAsking(false);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}
