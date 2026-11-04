import { useEffect, useMemo, useState } from "react";
import { AccountConnections } from "./AccountConnections";
import { MausAvatar } from "./Avatar";
import { ChatPlanMeters } from "./ChatPlanMeters";
import { Card } from "./SettingsPrimitives";
import { TraderChatSurface, TraderConnectionsCard, TraderUsageDeck } from "./TraderUsageDeck";
import { UsageSection } from "./UsageSection";
import { groupAccounts } from "@/lib/accounts";
import { applyLocale } from "@/lib/i18n";
import { applySkin, type SkinId } from "@/lib/skins";
import { setUsageMode } from "@/lib/usage-preferences";
import {
  createTraderFixtureAppState,
  DEMO_NOW,
} from "@/lib/trader-fixtures";
import {
  DispatchContext,
  EMPTY_STREAM,
  StoreContext,
  StreamContext,
} from "@/state/store";

declare global {
  interface Window {
    __DEMO_NOW__?: number;
    __setMotionFrame?: (frame: number, totalFrames: number) => void;
  }
}

export function TraderPrototypeHarness() {
  const params = new URLSearchParams(window.location.search);
  const proto = params.get("proto") ?? "concept"; // "today" | "concept" | "motion"
  const view = params.get("view") ?? "usage"; // "usage" | "chat" | "connections"
  const skin = (params.get("skin") ?? "github-dimmed") as SkinId;
  const locale = params.get("locale") === "ko" ? "ko" : "en";

  const [motionFrame, setMotionFrame] = useState(0);
  const [totalMotionFrames, setTotalMotionFrames] = useState(270);

  useEffect(() => {
    window.__DEMO_NOW__ = DEMO_NOW;
    setUsageMode("remaining");
    applySkin(skin);
    applyLocale(locale);
    window.dispatchEvent(new Event("wink-demo-now"));
  }, [skin, locale]);

  useEffect(() => {
    window.__setMotionFrame = (frame: number, total: number) => {
      setMotionFrame(frame);
      setTotalMotionFrames(total);
      window.__DEMO_NOW__ = DEMO_NOW + frame * 20_000;
      window.dispatchEvent(new Event("wink-demo-now"));
    };
    return () => {
      delete window.__setMotionFrame;
    };
  }, []);

  // Derive deterministic motion state from motionFrame (0..269)
  const progress = motionFrame / Math.max(1, totalMotionFrames - 1);
  const motionPhase: 1 | 2 | 3 = progress < 0.34 ? 1 : progress < 0.67 ? 2 : 3;

  // Phase 1: live numbers ticking from 68.4% -> 66.0%
  // Phase 2: manual switch to C3 (40% left)
  // Phase 3: auto-switch moment C2 (0%) -> C1 (66% left)
  const motionMainClaude: "claudeAgent" | "claudeAgent~3" =
    motionPhase === 2 ? "claudeAgent~3" : "claudeAgent";
  const motionLive5h =
    motionPhase === 1
      ? Number((68.4 - (progress / 0.34) * 2.4).toFixed(1))
      : motionPhase === 2
        ? 40
        : Number((66.8 - ((progress - 0.67) / 0.33) * 0.8).toFixed(1));

  const appState = useMemo(
    () =>
      createTraderFixtureAppState(
        DEMO_NOW,
        proto === "motion" ? motionMainClaude : "claudeAgent",
      ),
    [proto, motionMainClaude],
  );

  const noopDispatch = () => {};
  const noopReload = async () => {};
  const noopFlush = async () => {};
  const groups = useMemo(() => groupAccounts(appState.instances), [appState.instances]);
  const c1Instance = appState.instances[0]!;

  return (
    <DispatchContext.Provider value={noopDispatch}>
      <StoreContext.Provider value={{ state: appState, dispatch: noopDispatch, flushBotPatches: noopFlush, refreshInstances: noopReload }}>
        <StreamContext.Provider value={EMPTY_STREAM}>
          <div
            data-skin={skin}
            className="min-h-screen w-full bg-surface text-ink antialiased"
          >
            {proto === "today" && (
              <div className="mx-auto w-full max-w-[960px] p-3.5">
                {view === "usage" && <UsageSection legacy />}
                {view === "chat" && (
                  <div className="flex h-[560px] flex-col justify-between rounded-[6px] border border-hairline/50 bg-surface">
                    <div className="flex items-center gap-2 border-b border-hairline/40 px-4 py-2.5">
                      <MausAvatar color="coral" state="idle" size={22} animated={false} />
                      <span className="text-[13.5px] font-semibold text-ink">Kai</span>
                      <span className="text-[12px] text-ink-secondary">Claude Code · Opus 4.6</span>
                    </div>
                    <div className="flex flex-1 flex-col justify-end gap-3 p-4">
                      <div className="max-w-[85%] rounded-[6px] border border-hairline/40 bg-raised/35 px-3 py-2 text-[12.5px] text-ink">
                        Running parallel evaluation across repository modules...
                      </div>
                      {/* Today's usage-wait card at ab89c492 */}
                      <div className="rounded-[6px] border border-hairline/50 bg-raised/40 px-3.5 py-2.5 text-[12.5px]">
                        <div className="font-medium text-ink">
                          Hit the usage limit · waiting until Monday 5:00 PM
                        </div>
                        <div className="mt-1 text-[12px] text-ink-secondary">
                          Will continue automatically when the limit resets.
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded-[4px] border border-hairline/60 bg-raised px-2.5 py-1 text-[12px] text-ink"
                          >
                            Try now
                          </button>
                          <button
                            type="button"
                            className="rounded-[4px] border border-hairline/40 px-2.5 py-1 text-[12px] text-ink-secondary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="border-t border-hairline/40 pt-2 pb-3">
                      <ChatPlanMeters
                        windows={c1Instance.rateLimits?.windows}
                        driverKind="claudeAgent"
                        observedAt={c1Instance.rateLimits?.observedAt}
                        now={DEMO_NOW}
                        onOpenUsage={() => {}}
                      />
                      <div className="mx-4 mt-1 flex h-9 items-center rounded-[5px] border border-hairline/50 bg-raised/25 px-3 text-[12.5px] text-ink-secondary">
                        Message Kai...
                      </div>
                    </div>
                  </div>
                )}
                {view === "connections" && (
                  <Card title="Connections" subtitle="Sign in to your AI accounts.">
                    <div className="flex flex-col divide-y divide-hairline/30">
                      {groups.map((grp) => (
                        <AccountConnections key={grp[0]!.instanceId} accounts={grp} reload={noopReload} />
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            )}

            {proto === "concept" && (
              <div className="mx-auto w-full max-w-[980px] p-3">
                {view === "usage" && <UsageSection />}
                {view === "chat" && (
                  <div className="overflow-hidden rounded-[6px] border border-hairline/50">
                    <TraderChatSurface initialQuickHudOpen showWaitCard />
                  </div>
                )}
                {view === "connections" && <TraderConnectionsCard />}
              </div>
            )}

            {proto === "motion" && (
              <div className="flex h-[720px] w-[1280px] flex-col overflow-hidden bg-surface p-3">
                {/* Top live motion status bar */}
                <div className="mb-2.5 flex items-center justify-between rounded-[4px] border border-accent/45 bg-raised/80 px-3.5 py-1.5 font-mono text-[12px]">
                  <div className="flex items-center gap-2.5">
                    <span className="inline-flex items-center gap-1.5 rounded bg-accent/20 px-2 py-0.5 font-semibold text-accent">
                      <span className="size-2 rounded-full bg-accent" />
                      {motionPhase === 1
                        ? "1/3 LIVE PACE TICK"
                        : motionPhase === 2
                          ? "2/3 MANUAL SWITCH (C1 -> C3)"
                          : "3/3 AUTO-ROTATION (C2 0% -> C1)"}
                    </span>
                    <span className="text-ink">
                      {motionPhase === 1
                        ? `C1 5h remaining ticking live: ${motionLive5h.toFixed(1)}% · Pace ray updating (-4.8%/h -> +${Math.round(motionLive5h - 18)}% at 6:40 PM)`
                        : motionPhase === 2
                          ? "User clicked [Use C3] in-place · C3 is now Main (40% 5h · 72% 7d) · Fixed row order C1, C2, C3 preserved"
                          : "C2 hit 0% limit at 11:52 AM -> Auto-switched Kai + 3 workers to C1 (66.0% left) with provenance badge"}
                    </span>
                  </div>
                  <span className="text-ink-secondary tabular-nums">
                    Thu 3:00 PM · Frame {String(motionFrame + 1).padStart(3, "0")}/{totalMotionFrames}
                  </span>
                </div>

                {/* Split 2-column live trader deck + chat with HUD */}
                <div className="grid flex-1 grid-cols-[1.18fr_0.82fr] gap-3 overflow-hidden">
                  <div className="overflow-hidden">
                    <TraderUsageDeck
                      externalMainClaudeId={motionMainClaude}
                      liveRemaining5hOverride={motionLive5h}
                      autoSwitchFlash={motionPhase === 3}
                    />
                  </div>
                  <div className="overflow-hidden rounded-[6px] border border-hairline/50">
                    <TraderChatSurface
                      initialQuickHudOpen
                      showWaitCard
                      mainClaudeId={motionMainClaude}
                      liveRemaining5h={motionLive5h}
                      autoSwitchBanner={
                        motionPhase === 3
                          ? "AUTO-SWITCHED: C2 (0%) -> C1 (Kai + 3 workers continued)"
                          : null
                      }
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </StreamContext.Provider>
      </StoreContext.Provider>
    </DispatchContext.Provider>
  );
}
