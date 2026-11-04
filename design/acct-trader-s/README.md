# Runway

Fixture prototype for ACCT-TRADER-S. Base: `ab89c492`.

- Concept: a remaining-allowance trace, reset jumps and a dotted pace estimate.
- Baseline: real UsageSection, UsageAccounts, PlanWindowMeter, ChatPlanMeters, AccountConnections and ErrorRow components. Only the surrounding shell and API/store are fixtures.
- Tokens: extracted unchanged from `src/styles.css`. This base has no `src/index.css`.
- Skins: GitHub Dimmed, Code Review (light), Terminal. English and Korean. Native widths: 1280 and 390.
- All seven accounts come from `fixtures.mjs`. Percentages mean remaining allowance; source reports use the complement as `usedPercent`.
- No provider request, product server, account home or installed app is used.

Build and capture, from the repo root:

```powershell
node design/acct-trader-s/build.mjs
npm install --prefix "$env:TEMP\wink-ACCT-TRADER-S" --no-save playwright-core sharp
node design/acct-trader-s/capture.mjs
```

Both scripts wait only for lock lines naming GO-, PERF-, SPEED- or gate timing work. EP2 render holders do not block shots. The lock is never changed. Node, Chromium and ffmpeg run at BelowNormal priority. Capture uses one isolated headless Chromium with `--mute-audio`, a loopback fixture server and an outbound allowlist. Scratch stays in `%TEMP%\wink-ACCT-TRADER-S`.

Deliverables: `C:\Users\mredw\Desktop\Orbit-extras\Orbit-cards\day-1104\acct-trader\concept-s\`.

Interactions: engine tabs, today/7-day history, Use, pin/automatic policy, meter, Alt+U, Escape, focus return, wait-card recovery and Connections fixture actions. The automatic fixture routes a new worker from exhausted Claude 2 to Claude 3; Main remains Claude 1. No running work transfers. Numbers and the final trace segment ease for 550ms after a fixture report; reduced motion settles immediately.

Motion capture compresses report time. It begins with the same account values as the sheets, changes Codex Main from 1 to 2, then shows the confirmed new-worker route. This demonstrates the interface, not provider handoff or backend race safety.
