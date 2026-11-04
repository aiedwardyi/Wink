# Research receipts

Checked 2026-11-04. Public primary sources only. README and official documentation review, without account sign-in. No competitor concept folder was opened.

| Source | Observed in the real source | Port to Runway |
| --- | --- | --- |
| [Switcher README](https://github.com/00xmario/Switcher) | Per-account quota windows, reset countdowns and one-click account changes; running agents need not be interrupted. | Keep stable accounts beside quota and action; distinguish choosing a new account from moving live work. |
| [CodexBar README](https://github.com/steipete/CodexBar) | Tiny persistent provider readings, session/weekly/monthly windows and reset countdowns. | Keep an always-available meter; make the detailed view a direct continuation. |
| [Claude-Code-Usage-Monitor README](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | Burn rate, reset-aware forecasting and official-versus-estimated provenance; local history surfaces. | Pair remaining allowance with estimated room at reset. Keep estimates explicit. A simple slope suffices here. |
| [ccusage live-monitoring docs](https://ccusage.com/guide/live-monitoring) | Archived v17 `blocks --live` combines block progress, burn rate, time and projections. The current page explicitly says the feature was removed in v18. | Borrow the compact relationship between allowance, pace and reset time. Do not add one-second provider polling. |
| [Apple Stocks chart guide](https://support.apple.com/en-za/guide/stocks/stc4cfc704df/mac) | Shared time-range selection and direct point/range inspection on the chart. | Keep one chart in focus; retain the chosen range across account changes. The fixture exposes today/7-day burn, with detailed scrubbing deferred. |
| [iStat Menus](https://bjango.com/mac/istatmenus/) | Menu-bar glance leads to historical graphs and lists of the active consumers. | Tiny chat trace opens a richer view; names identify activity without pretending to know each worker's quota share. |
| [Grok Bot settings](https://docs.x.ai/grok-bot/settings-and-notifications) | Documents weekly included and on-demand usage in Usage & Billing and a possible weekly glance in the account menu. Saved accounts can be switched. | Preserve the short glance path. Add a separate trace per account instead of blending providers or billing pools. |

Grok Bot observation is based on its official docs, not a signed-in visual audit. Availability varies by rollout. A missing reading in Wink remains unknown, even when another product has a weekly meter.

Prior work read: both `acct-switch/pitch-o/PITCH.md` and `pitch-s/PITCH.md`; account-choice and auto-switch architecture results; ACCT-STRESS findings. Runway keeps their stable identity and transactional confirmation, adds time and burn history, and honors new-worker-only automatic routing with user-owned Main.

The brief names `src/index.css`. At ab89c492 the canonical file is `src/styles.css`. The build script extracts GitHub Dimmed, Code Review and Terminal token blocks unchanged from that file. Baseline surfaces import current components directly; only their API/store and outer shell are fixtures.

Decisions left open by the brief:

- Percentages mean remaining, matching the earlier pitch fixtures. Reports carry the complementary usedPercent. No pool is added across accounts or windows.
- The fixture clock is Thu Nov 5, 2026, 15:00 KST, so the supplied Monday reset is 4d 2h away.
- Claude 3 has 40% of 5h and 74% of 7d. Codex 2 retains 14% weekly from the earlier fixture. Gemini, like Grok, awaits its first report.
- The chart's x axis is linear time, 07:00 to 18:40. Two observed reset jumps are retained. New-window consumption is never mistaken for negative burn.
- Last-hour Claude 1 samples fall from 72% to 66%. The last 30 minutes fall from 69% to 66%, giving 6 quota points/hour. Over 3h 40m that projects 44% remaining, explicitly estimated.
- History bars use five-hour quota percentage-point deltas, not tokens or money. Today's eight hourly intervals total 204 points across refills; the final seven-day daily value is also 204.
- Strict pin targets an engine account. A deliberate manual Use updates both Main and an existing pin; automatic new-worker routing leaves Main unchanged.
- No new provider calls, global shortcuts, polling loops, process termination or production behavior are implemented by this prototype.

Active bot attribution needs the captured turn account ID exposed to the UI. Current Main is a preference and can change while an old turn still runs; it must never be used to infer that turn's account. Workers already have pane-run account records. This needs transient event data, not another persistent store.
