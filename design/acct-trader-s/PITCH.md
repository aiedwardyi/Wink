# Runway

See your remaining room and whether it lasts until reset.
A solid trace records reports; a dotted tail estimates the landing.
Switch beside the chart. Main and running work stay distinct.

| Place | What users see |
| --- | --- |
| Usage | Room-at-reset chart, seven stable account rows, today/7-day burn against usual. |
| Chat meter | Account tile, room, tiny trace, reset countdown. |
| Quick view | Meter or Alt+U opens the same chart/rows. Escape returns focus. |
| Wait card | Out-until time, countdown, Use Claude 3, Cancel. Only the queued action moves. |
| Connections | Tiles beside addresses, Add, Sign out. Starting/running work must drain safely. |
| Phone | 390px aligned columns, same quick view, expandable active names. |

| Job | /5 | Reason |
| --- | --- | --- |
| 1 Glance | 5 | Every account's room and Main; no pooled quota. |
| 2 Will it last | 4 | Estimated room at reset; unknown/stale pace stays unknown. |
| 3 Refills | 5 | Exact resets and countdowns for each reported window. |
| 4 Switch | 4 | One-tap Main, strict pin, confirmed new-worker move; running work stays. |
| 5 Who spends | 4 | Names map to accounts; spend shares are unreported. |
| 6 History | 4 | Local today/7-day comparisons; partial coverage stays explicit. |
| 7 Manage | 5 | One Connections destination with stable identities. |

Data exists: window reports, observation time, Main, readiness and pane-run account IDs. New: display ordinal/strict pin in account settings; captured bot-turn account IDs and confirmed routing events exposed to the UI. Smallest new store: one local sample ring, max 4 MiB/seven days, containing account/window IDs, time, usedPercent, resetsAt and windowMinutes. Coalesce at five minutes; preserve resets; compact older samples hourly; evict oldest under pressure. No email, polling or AI tokens.

Pace: three fresh samples over 15+ minutes. Gaps break the trace; resets restart slope. Initial 6 points/hour means 66% now, estimated 44% at 18:40. Usual uses covered-day medians. Hide predictions after five stale minutes. Incoming reports ease 550ms; reduced motion settles.

Cuts: paging, anonymous columns, duplicated switchers, Used/Remaining toggle and warning badges. Remaining is the sole direction. Main affects next messages; automation only new workers. Manual Use updates an existing pin.

Build: ~18 view/history/contract/test files, reusing current components, tokens and transport. Account-choice architecture is a dependency. Risks: sparse history, false certainty, stale replies, starting-turn sign-out and phone keyboard clearance. Require confirmed switches, versioned events and drain guards.

Seven primary references opened; ports:

- [Switcher](https://github.com/00xmario/Switcher): per-account windows and direct choice.
- [CodexBar](https://github.com/steipete/CodexBar): persistent glance and resets.
- [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor): reset-aware pace and explicit estimates.
- [ccusage](https://ccusage.com/guide/live-monitoring): allowance, pace and time together; archived v17 live view, removed in v18.
- [Apple Stocks](https://support.apple.com/en-za/guide/stocks/stc4cfc704df/mac): one focal trace, shared ranges.
- [iStat Menus](https://bjango.com/mac/istatmenus/): tiny graph opens history/consumers.
- [Grok Bot](https://docs.x.ai/grok-bot/settings-and-notifications): documented weekly/on-demand view and account-menu glance; no sign-in.

Fixture clock: Thu Nov 5, 15:00 KST. Percentages mean remaining. One module drives every crop/clip; only incoming reports advance in motion. Exact fixtures: [RESEARCH.md](RESEARCH.md).

Artifacts: concept.png, today.png, motion.mp4; states.png adds wait/Connections. Today imports real ab89c492 components in a fixture shell. Tokens are src/styles.css; src/index.css is absent.

Phone-first review: all 36 concept crops; wraps, targets and labels fixed. All 72 crops pass privacy. Clip: silent H.264, ~9.6s, live pace and both switch moments.

@ outside Connections, Usage/Chat/States; identical concept/Today results:

| Skin / language | Phone | Desktop |
| --- | --- | --- |
| GitHub Dimmed / EN | 0/0/0 | 0/0/0 |
| GitHub Dimmed / KO | 0/0/0 | 0/0/0 |
| Code Review light / EN | 0/0/0 | 0/0/0 |
| Code Review light / KO | 0/0/0 | 0/0/0 |
| Terminal / EN | 0/0/0 | 0/0/0 |
| Terminal / KO | 0/0/0 | 0/0/0 |
