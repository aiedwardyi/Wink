import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { useI18n, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { devicesSetup } from "@/lib/devices-setup";
import type { RemotePhoneLink } from "@/lib/phone-setup";
import { api } from "@/state/store";
import { SegmentedRow } from "./Segmented";
import { button, GetTailscaleLink, openOutside, StepMark, StoreCodes, StoreLinks } from "./DeviceSetupParts";

function activeText(lastSeen: number, now: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now - lastSeen) / 60000);
  if (minutes < 2) return t("settings.phone.activeNow");
  if (minutes < 60) return t("settings.phone.activeMinutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("settings.phone.activeHours", { n: hours });
  return t("settings.phone.activeDays", { n: Math.floor(hours / 24) });
}

function Step({ n, done, active, title, label, children }: { n: number; done: boolean; active: boolean; title: string; label: string; children?: ReactNode }) {
  return (
    <li data-device-step={n} data-complete={done} data-active={active} className="flex items-start gap-3">
      <StepMark done={done} step={n} label={label} muted={!done && !active} />
      <div className="min-w-0 flex-1">
        <h3 className={cn("pt-1 text-[13px] font-medium", done || active ? "text-ink" : "text-ink-secondary")}>{title}</h3>
        {children}
      </div>
    </li>
  );
}

const help = "mt-1 break-keep text-[12px] leading-relaxed text-ink-secondary";
let lastStatus: RemotePhoneLink | null = null;

export function ConnectDevices() {
  const { t } = useI18n();
  const onThisPc = Boolean(window.ogb) || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const phone = !onThisPc;
  const deviceWindow = window.ogb?.deviceWindow;
  const [status, setStatus] = useState<RemotePhoneLink | null>(lastStatus);
  const [tab, setTab] = useState<"phone" | "pc">("phone");
  const [copied, setCopied] = useState(false);
  const [loginOpened, setLoginOpened] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const [loginFailed, setLoginFailed] = useState(false);
  const [allowOpened, setAllowOpened] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pcFailed, setPcFailed] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const live = useRef(true);
  const signedInHere = useRef(false);
  const waiting = useRef<{ state: string; until: number } | null>(null);
  const waitForChange = () => {
    if (status?.setup?.state === "ready") return;
    waiting.current = { state: JSON.stringify([status?.setup?.state, status?.setup?.backendState]), until: Date.now() + 60_000 };
    setRefresh((value) => value + 1);
  };

  useEffect(() => {
    live.current = true;
    let active = true;
    let pending = false;
    let first = lastStatus === null;
    let ready = false;
    let probedAt = 0;
    let timer: number | undefined;
    const load = async (probe = false) => {
      if (pending || document.visibilityState === "hidden") return;
      window.clearTimeout(timer);
      pending = true;
      try {
        // A periodic real probe finds PCs and phones that join while the page stays open.
        const cached = first || (ready && !probe && !waiting.current && Date.now() - probedAt < 30_000);
        if (!cached) probedAt = Date.now();
        const body: RemotePhoneLink = await api(`/api/remote-link?setup=1${cached ? "&cached=1" : ""}`);
        if (active) {
          lastStatus = body;
          ready = body.setup?.state === "ready" && Boolean(body.url);
          if (waiting.current && (Date.now() >= waiting.current.until || waiting.current.state !== JSON.stringify([body.setup?.state, body.setup?.backendState]))) waiting.current = null;
          setStatus(body);
          if (body.setup?.backendState !== "NeedsLogin") setLoginOpened(false);
        }
      } catch {
        ready = false;
        if (active) setStatus({ url: null, setup: { state: "error" } });
      } finally {
        pending = false;
        if (waiting.current && Date.now() >= waiting.current.until) waiting.current = null;
        if (first) {
          first = false;
          if (active) void load(true);
        } else if (active) timer = window.setTimeout(() => void load(), waiting.current ? 2_000 : 6_000);
      }
    };
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    void load();
    return () => {
      active = false;
      live.current = false;
      window.clearTimeout(timer);
      window.clearTimeout(copiedTimer.current);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    const enableUrl = status?.setup?.enableUrl;
    if (!signedInHere.current || status?.setup?.state !== "serve-disabled" || !enableUrl || !window.ogb?.openExternal) return;
    signedInHere.current = false;
    void window.ogb.openExternal(enableUrl).then(() => {
      if (live.current) {
        setAllowOpened(true);
        waitForChange();
      }
    }, () => {});
  }, [status?.setup?.state, status?.setup?.enableUrl, loginOpened]);

  const setup = devicesSetup(status, loginOpened || loginPending);
  const { installed, signedIn, ready, account, phoneJoined, phoneOpened } = setup;
  const phones = status?.phones ?? [];
  const pcs = status?.pcs ?? [];
  const signIn = async () => {
    if ((!setup.canSignIn && !setup.loginOpened) || status?.setup?.haveNodeKey || loginPending) return;
    setLoginPending(true);
    setLoginFailed(false);
    try {
      const { url }: { url: string | null } = await api("/api/devices/sign-in", { method: "POST" });
      if (!url) throw new Error("No sign-in URL");
      if (window.ogb?.openExternal) await window.ogb.openExternal(url);
      else window.open(url, "_blank", "noopener,noreferrer");
      if (live.current) {
        signedInHere.current = true;
        setLoginOpened(true);
        waitForChange();
      }
    } catch {
      if (live.current) setLoginFailed(true);
    } finally { if (live.current) setLoginPending(false); }
  };
  const copy = async () => {
    if (!setup.url) return;
    try {
      await navigator.clipboard.writeText(setup.url);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  const copyButton = <button type="button" onClick={() => void copy()} className={`${button} mt-2`}>
    {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
    {copied ? t("settings.phoneLink.copied") : t("settings.phoneLink.copy")}
  </button>;

  if (!status) return null;

  return (
    <div data-devices-settings className="animate-fade-in">
      {phoneOpened && <ul data-phone-list className="mb-3 flex flex-col gap-1.5">
        {phones.map((item) => <li key={item.id} className="text-[13px] text-ink">
          {t(`settings.phone.kind.${item.kind}`)}<span className="text-ink-secondary"> · {activeText(item.lastSeen, Date.now(), t)}</span>
        </li>)}
      </ul>}
      <p className="break-keep text-[13px] leading-relaxed text-ink-secondary">{t("settings.devices.b.intro")}</p>
      {ready ? <div data-pc-ready data-complete className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-secondary">
        <StepMark done step={1} label={t("settings.phone.pcReady")} />
        <span className="text-ink">{t("settings.devices.thisPc")}</span>
        {account && <span>· {t("settings.devices.signedInAs", { account })}</span>}
      </div> : <ol className="mt-3 flex flex-col gap-2">
        <Step n={1} done={installed} active={!installed} title={t("settings.phone.getTailscale")} label={t("settings.phone.pcReady")}>
          {setup.state === "missing" ? <GetTailscaleLink primary onOpen={waitForChange} /> : <div className="mt-1"><GetTailscaleLink onOpen={waitForChange} /></div>}
          {setup.state === "checking" && <p className={help}>{t(setup.help)}</p>}
        </Step>
        <Step n={2} done={signedIn} active={installed && !signedIn} title={t("settings.devices.signIn")} label={t("settings.phone.pcReady")}>
          {signedIn && account && <p className={help}>{t("settings.devices.signedInAs", { account })}</p>}
          {installed && !signedIn && <>
            {setup.needsApproval ? <p className={help}>{t("settings.devices.needsApproval")}</p>
              : !onThisPc ? <p className={help}>{t("settings.devices.signInOnPc")}</p>
              : setup.loginOpened ? <>
                <p className={help}>{t("settings.devices.finishSignIn")}</p>
                <button type="button" disabled={loginPending} onClick={() => void signIn()} className="mt-1 text-[12px] text-ink-secondary underline hover:text-ink">{t("settings.devices.signIn")}</button>
              </>
              : setup.canSignIn ? <button type="button" disabled={loginPending} onClick={() => void signIn()} className={`${button} mt-1`}>{t("settings.devices.signIn")}</button>
              : <p className={help}>{t(setup.help)}</p>}
            {loginFailed && <p role="alert" className={help}>{t("settings.phoneLink.notRunning")}</p>}
          </>}
        </Step>
        <Step n={3} done={false} active={signedIn} title={t("settings.devices.allow")} label={t("settings.phone.pcReady")}>
          {signedIn && (setup.state === "serve-disabled" && status?.setup?.enableUrl ? <>
            <a href={status.setup.enableUrl} target="_blank" rel="noreferrer" onClick={(event) => {
              openOutside(event, status.setup!.enableUrl!);
              setAllowOpened(true);
              waitForChange();
            }} className={`${button} mt-1`}>{t("settings.devices.allowButton")}</a>
            {allowOpened && <p className={help}>{t("settings.devices.allowHelp")}</p>}
          </> : <p className={help}>{t(setup.help)}</p>)}
        </Step>
      </ol>}
      <div className="mt-3 border-t border-hairline/40 pt-3">
        <SegmentedRow
          label={t("settings.devices.add")}
          value={tab}
          options={(["phone", "pc"] as const).map((id) => ({ id, label: t(`settings.devices.${id}`) }))}
          onChange={setTab}
        />
      </div>
      <ol key={tab} className="animate-fade-in mt-3 flex flex-col gap-3">
        {tab === "phone" ? <>
          <Step n={1} done={phoneJoined} active={ready && !phoneJoined} title={t("settings.devices.phoneStep")} label={t("settings.phone.phoneReady")}>
            {phoneJoined ? <div className="mt-1"><StoreLinks /></div> : <>
              <p className={help}>{account ? t("settings.devices.phoneHelp", { account }) : t("settings.devices.phoneHelpSame")}</p>
              <StoreCodes phone={phone} />
            </>}
          </Step>
          <Step n={2} done={phoneOpened} active={ready && !phoneOpened} title={t("settings.devices.scanStep")} label={t("settings.phone.phoneReady")}>
            {setup.url && <div className="animate-fade-in">
              {!phone && <div data-phone-link-qr className="mt-2 w-fit rounded-xl bg-white p-3" aria-label={t("settings.phoneAccess.qrLabel")}>
                <QRCodeSVG value={setup.url} size={168} level="M" bgColor="#ffffff" fgColor="#111111" />
              </div>}
              {copyButton}
            </div>}
          </Step>
        </> : <>
          <Step n={1} done={setup.pcOnline} active={ready && !setup.pcOnline} title={t("settings.devices.pcStep")} label={t("settings.devices.pcStep")}>
            <p className={help}>{account ? t("settings.devices.pcHelp", { account }) : t("settings.devices.pcHelpSame")}</p>
            <div className="mt-1"><GetTailscaleLink onOpen={waitForChange} /></div>
            {ready && copyButton}
          </Step>
          {deviceWindow && <Step n={2} done={false} active={ready && setup.pcOnline} title={t("settings.devices.openPcEmpty")} label={t("settings.devices.openButton")}>
            {pcs.map((pc) => <button key={pc.host} type="button" onClick={() => {
              setPcFailed(false);
              void deviceWindow.open(pc.host, pc.name).then((opened) => {
                if (!live.current || opened) return;
                setPcFailed(true);
                setRefresh((value) => value + 1);
              }, () => { if (live.current) setPcFailed(true); });
            }} className={`${button} mr-2 mt-2`}>{t("settings.devices.openPc", { name: pc.name })}</button>)}
            {pcFailed && <p role="alert" className={help}>{t("settings.phoneLink.notRunning")}</p>}
          </Step>}
        </>}
      </ol>
    </div>
  );
}
