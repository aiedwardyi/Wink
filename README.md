<h1 align="center">
  <img src="build/icon-1024.png" width="88" alt=""><br>
  Wink
</h1>

<p align="center">
  <a href="https://github.com/aiedwardyi/Wink/actions/workflows/ci.yml"><img src="https://github.com/aiedwardyi/Wink/actions/workflows/ci.yml/badge.svg?branch=review-base" alt="CI"></a>
  <a href="https://github.com/aiedwardyi/orbit-releases/releases/latest"><img src="https://img.shields.io/github/v/release/aiedwardyi/orbit-releases?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 License"></a>
</p>

<p align="center">
  <b>The harness for self-improving frontier agents.</b>
  <br>
  Claude, Codex, Grok, Gemini and Muse in one app, at terminal speed.
  <br>
  Runs on the Claude Code, Codex, Gemini, Grok and Muse logins you already have. No API keys. Usage stats are anonymous and never include your chats.
</p>

<p align="center">
  <a href="https://github.com/aiedwardyi/orbit-releases/releases/latest/download/Wink-setup.exe"><b>Download for Windows</b></a> (10 / 11, x64) · <a href="https://youtu.be/dBWTcXMwIsU">Watch the demo</a> · <a href="https://github.com/aiedwardyi/orbit-releases/releases">All releases</a> · <a href="https://getwink.dev">Website</a>
  <br>
  Built by <a href="https://github.com/aiedwardyi">Edward Yi</a>
</p>

<img src="./assets/readme/hero-v2.png" alt="Atlas splits a checkout task across four workers on four engines, all Done, with Live Verify 15 passed, the repo map and the code change beside the chat.">

## Tour

**1. Switch models mid-thread**<br>
Pick a model and an effort for each bot, and it keeps its whole thread. `Alt+M` opens the picker.

<img src="./assets/readme/tour-models-v2.png" width="880" alt="The Dial model picker: GPT-6.2 Sol at High effort, with Intelligence, Coding and Cost for that pick.">

**2. One job. Workers on every engine**<br>
Ask once. Your orchestrator splits the job, picks each worker's engine, model and effort, and checks the work before it lands. You talk to one chat.

<p align="center">
  <img src="./assets/readme/tour-workers.png" width="660" alt="Five worker rows, each with its engine's mark and model: three working, two done.">
</p>

**3. Real terminals**<br>
Each worker runs its engine's own CLI in its own terminal, and the lead bot is told to give each one its own git worktree. Press `` Ctrl+` `` to drive it yourself.

<p align="center">
  <img src="./assets/readme/tour-terminal.png" width="560" alt="Terminal tabs labeled LIMITER, DOCS and REVIEW with model and effort, over the LIMITER worker's session.">
</p>

**4. Wink trusts the checks, not the AI**<br>
Every bot is told to fix the root cause and turn each mistake into a test that fails if it comes back. Then Live Verify opens the page in a real browser, clicks through it at phone size and shows you what's broken.

**▶ Press play:** 14 seconds of Live Verify clicking through a page at phone size.

https://github.com/user-attachments/assets/c3883bbd-249b-4bf5-b16d-8a842f9849a1


**5. Memory that carries across sessions and keeps getting better**<br>
Each bot keeps one memory across its chats, models and your phone, and across your PCs with Sync on. It writes down what it learns and keeps a to-do list of what you asked, so a new chat starts with what it already knows.

<img src="./assets/readme/tour-memory-v2.png" width="880" alt="Atlas's Memory page: Long-Term Memory, Live Now with the task in progress, Knowledge files and Habits.">

**6. Every decision, on a Timeline**<br>
When you decide something in chat, Wink writes it down: the options, the one you chose, and your exact words. Change your mind later and the old choice gets crossed out.

<!-- VIDEO: timeline-demo-after.mp4 -->
<img src="./assets/readme/tour-timeline-v2.png" width="880" alt="Chat with Atlas next to its Timeline: each pick has the chosen option circled, the others crossed out, and your exact words beside it.">

**7. Your bots teach each other**<br>
Your bots share a private Forum. When one makes a mistake and finds the fix, it posts it. When another gets stuck, it searches the Forum first.

<img src="./assets/readme/tour-forum-v2.png" width="880" alt="The Forum: posts from five bots tagged Fix, Tip, Stuck and Handoff, with the bot, its model and the time on each.">

**8. One phone. Every PC**<br>
Check on any bot, send it work, open its terminal, and get a push when it needs you. Over your Tailscale tailnet or a [relay you host](relay/README.md).

<img src="./assets/readme/tour-phone-v2.png" width="880" alt="Wink on desktop and phone: Atlas runs the card tests on the Home PC, Live Verify checkout 15 passed, and the same chat on the phone.">

**9. 50+ themes**<br>
Animated scenes that move while your bot works, classics like Tokyo Night, or a chat that reads like a CLI. All run on your PC for 0 tokens. `Alt+Shift+T` cycles them.

<img src="./assets/readme/tour-themes.png" width="880" alt="Orion's chat in the Samurai Ink theme next to theme tiles: Night Rain, Warp, Circuit, Neon Grid, Lagoon, Snow, Tokyo Night, Claude and TUI.">

## How it works

```mermaid
flowchart LR
  you([You]) --> lead["Lead bot<br/>on any engine"]
  lead -->|"one pane per worker"| cli["Engine's own CLI<br/>in a pseudo-terminal"]
  cli -->|"works in"| wt[("Git worktree<br/>per worker")]
  cli -->|"orbit-msg --report"| lead
  lead -->|"after a turn that edits a page"| lv["Live Verify<br/>real browser, desktop and phone"]
  lv -->|"what broke"| lead
```

- **Official CLIs, no API keys.** Each engine is its vendor's own CLI, signed in with your login, running in a pseudo-terminal (`node-pty`).
- **Localhost and a token.** The server binds `127.0.0.1`, rejects foreign Host and Origin headers, and makes a fresh token each launch.
- **Panes get no secrets.** A pane's shell starts without Wink's variables or anything named like a token, secret, password or API key. Its one grant posts its report to the bot that opened it.
- **Worktrees are a rule, not a lock.** The lead bot's playbook puts each worker in its own git worktree. Wink doesn't enforce it.

## Numbers

| | Wink | Compared with | |
|---|---|---|---|
| Launch to typing | 1.15 s | 1.12 s, bare Claude Code | [how](docs/benchmarks.md#launch-to-typing) |
| Memory with 20 chats | 361 MB | 1,000 MB, bare Claude Code | [how](docs/benchmarks.md#memory-with-20-chats) |
| Model picker open (`Alt+M`) | 67 ms | 136 ms before [#2048](https://github.com/aiedwardyi/Wink/pull/2048) | [how](docs/benchmarks.md#model-picker-open) |

One run on one Windows PC per row. Method, date, machine and source for each are in [docs/benchmarks.md](docs/benchmarks.md).

## Quickstart

1. Install at least one [engine CLI](#engines) and sign in once.
2. Download **[Wink-setup.exe](https://github.com/aiedwardyi/orbit-releases/releases/latest/download/Wink-setup.exe)** and run it (Windows 10 / 11, x64).
3. Wink finds the engines on this PC. Create a bot, give it a job, and message it like anyone else.

The installer isn't code-signed yet, so SmartScreen may say "Windows protected your PC". Choose **More info**, then **Run anyway**.

## Engines

| Engine | CLI | Sign in |
|---|---|---|
| Claude Code | `claude` | `claude` |
| Codex | `codex` | `codex login` |
| Gemini (Antigravity) | `agy` | `agy` |
| Grok | `grok` | `grok login` |
| Muse | `muse` | `muse login` |

Install on Windows (PowerShell):

```powershell
irm https://claude.ai/install.ps1 | iex                  # Claude Code
npm install -g @openai/codex                             # Codex (needs Node.js)
irm https://antigravity.google/cli/install.ps1 | iex     # Gemini (Antigravity)
irm https://x.ai/cli/install.ps1 | iex                   # Grok
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://api.meta.ai/muse-launcher.ps1 | iex"   # Muse
```

Engine logins stay in each CLI's own store. Wink drives the CLI with the session you already have. Add engines later in **Settings > Connections**. Muse runs natively and falls back to WSL.

## Trust and security

- Usage stats are anonymous and never include chats, files or names. Turn them off at first run or in **Settings > General**. GlitchTip error reports are off by default.
- Listens on this PC only, behind a per-launch token.
- Engine logins stay in each CLI's own store.
- New bots start in **Auto**: every tool request in a turn you start is approved, destructive ones included. On this PC's own screen, destructive or secret-reading actions still ask. In a turn nobody started (a schedule or a wake), Auto skips destructive commands, deletes outside the project folder and desktop control, and the bot says what it skipped.
- Workers run with their CLI's permission prompts off: `claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`, `muse --yolo`, `grok --always-approve`, `agy --dangerously-skip-permissions`.

<details>
<summary>Everything Wink listens on, sends and stores</summary>

This is everything Wink listens on, sends and stores, usage stats included.

**Listens** (this PC only)

- `127.0.0.1:8799` for the app (falls back to 18799, then 28799), behind a per-launch token and a Host/Origin check. The token lives in memory, and in a Claude turn's temp config until that turn ends.
- Random token-protected `127.0.0.1` ports for the terminal and browser bridges.

**Sends with no setup**

- Anonymous usage stats, while they're on (the first-run box, on by default; **Settings > General > Crash reports and stats** turns them off from this PC, your phone or the browser): a random install ID (deleted when you turn stats off), app version, OS, CPU cores, rounded RAM and screen scale, languages, how many bots, rooms and phones you have, which services have a key set (never the key), and counts and timings of screens, settings (old and new value), features, engines (with CLI versions), models, turns, tokens, cost, workers, crashes and errors, with error locations hashed. Never message text, file names or paths, bot or room names, emails, account IDs, room codes or error text. Batches go about every 30 minutes, at most 256 KB each, to the relay in the build's `WINK_STATS_URL` (no host is configured in this repo). The relay sees the PC's IP address but doesn't write it down, and keeps stats for 90 days.
- Update checks to GitHub Releases (`aiedwardyi/orbit-releases`) 15 s after launch, then hourly. The stock updater adds a random per-install ID header (`x-user-staging-id`) for staged rollouts. Downloads start only when you press the button and are checked against the release's sha512 hash. The build isn't code-signed yet.
- Your engine CLIs, which Wink starts to list models and check sign-in at launch, on refocus and in the model picker. Each talks to its own vendor with your login and keeps its own telemetry settings.
- `tailscale serve --bg --https=443` at launch when Tailscale is installed and logged in, so your phone can reach Wink over your tailnet. Tailnet only, never Funnel, and the API still needs the phone link's sign-in key. The rule stays after Wink quits. `ORBIT_REMOTE_AUTO=0` turns it off.
- Wink calls Anthropic's usage API with your Claude Code login when Settings or a usage view opens (if the last reading is over 5 minutes old), when a bot starts a worker, and on Refresh. If that login expired, Wink renews it and rewrites `~/.claude/.credentials.json`.
- Electron's built-in spellchecker, which can fetch a dictionary for your language from Google's Chromium CDN.

**Sends once you set something up**

- Opt-in error reports go to the GlitchTip host in the build's `ERROR_REPORT_DSN` (no host is configured in this repo), at most 5 uploads per PC per UTC day, off by default. They contain only app version, OS/architecture, fixed process/error/site codes, the error's type name and its top frame in the app bundle (chunk file:line:col), bounded counts/exit codes/uptime bucket, UTC hour and a random report ID. The host sees the PC's IP address.
- Phone relay, after you paste a setup code: a connection to your relay at every launch. TLS runs end to end between phone and PC, so the relay passes bytes it can't read. Wink also gets this PC's certificate from Let's Encrypt and checks crt.sh daily for certificates issued for its relay name. A team relay also takes stuck-worker reports from teammates' PCs for its owner (Wink version, engines and note times, scrubbed; never chats, files or terminal text), and they follow each PC's error-report setting.
- Phone notifications, once you allow them on the phone, go out encrypted through the phone browser's push service.
- Team relay: for a PC joined with the owner's setup code, it keeps the PC's name, its Wink profile name and when its person used Wink, for the owner's team page. A PC joined with Google sends no use times, and the relay keeps no name for it.
- Sync writes only to the folder you choose.
- Services you add a key for (Composio, ElevenLabs, AssemblyAI, the xAI API, Box (ascii.dev), OpenAI images, and custom providers in your Codex config) are called with that key when you or a bot use them. Composio is also called at every launch once its key is set, and each custom Codex provider is asked for its model list at launch.

**Sends only when you act**

- Team Library fetches a pinned snapshot of `milind-soni/openmausbot-teams` from GitHub. Skill import and install links also fetch from GitHub. Project scout queries `api.botdirectory.ai`. The Connected Apps panel loads app icons from Google's favicon service.
- Local VM and VPS setup pull images from Docker Hub and packages from PyPI, and reach your VPS over ssh.
- Images in a bot's reply load from wherever they point (there is no CSP), so a reply can make Wink fetch any URL.

**Stores**

- `~/.orbit` (or `OMB_DATA_DIR`): bots, chats (`messages.db`), each bot's `MEMORY.md`, task records, attachments, redacted engine event logs, phone pairing keys, and a decision log. `orbit-msg` lives in `~/.orbit/bin`.
- In `~/.orbit`: `analytics.json` (stats on or off), `stats-id` (the random install ID), `stats-queue.ndjson` (batches waiting to send, at most 1 MB, dropped after 14 days) and `stats-active` (marks a running session, to count unclean exits). Wink doesn't sync these.
- `%APPDATA%\orbit-desktop`: Wink's own API keys in `credentials.bin`, encrypted with the Windows credential store through Electron `safeStorage`, the updater's install ID, and logs. It also holds Electron's browser data: local storage (UI settings and unsent drafts), plus the cookies and logins of the bots' built-in browser and of the windows that open your other PCs.
- In the same userData folder: `error-report-consent.json` (consent), `error-report-queue.json` (pending reports), `error-report-budget.json` (daily upload count and backoff), and `error-report-active` (previous-run marker). These files are not synced by Wink.
- Outside those, only while needed: `~/.gemini/config/mcp_config.json` during Antigravity turns (restored after) and a temp `mcp.json` per Claude turn (deleted after). Picking a local model for Grok adds it to `~/.grok/config.toml`, with that server's API key if it has one, and the entry stays.
- Names: Wink was OpenMausBot, then Orbit. The old names in `~/.orbit`, `%APPDATA%\orbit-desktop`, the `OMB_` and `ORBIT_` variables, `orbit-msg` and the `orbit-releases` update feed stay on purpose, so existing installs keep their data, settings and updates.

**Approvals**

- **Ask** asks before any tool call you haven't always-allowed, and always before destructive or secret-reading ones. Codex runs in its workspace-write sandbox, unless you hand-edit an instance's config to `fullAuto` (no Settings screen does), which turns the sandbox off. Antigravity can't ask in print mode, so Ask has no effect there.
- Engine CLIs start without a shell and without your `*_KEY`, `*_TOKEN` and `*_SECRET` variables, except what a driver needs.

**Workers**

- The built-in playbook tells bots to run each worker in its own git worktree, never your checkout. That is an instruction to the bot, not something Wink enforces.
- Pane shells don't inherit Wink's tokens or secrets, except `ORBIT_MSG_AUTH`: a token that only lets that one pane post its report to the bot that opened it. Panes close when Wink quits.

Report vulnerabilities through [SECURITY.md](SECURITY.md).

</details>

## Requirements

- Windows 10 or 11, x64
- At least one engine CLI with an active login
- [Git for Windows](https://gitforwindows.org) on the PATH, for workers
- Optional: [Tailscale](https://tailscale.com) on the PC and phone, for phone access (the free plan works)
- To build: Node.js 24+ and pnpm 10.33

## Compatibility

<details>
<summary>Platform status and packages</summary>

| Platform | Package | Status |
|---|---|---|
| Windows 10 / 11 (x64) | Installer with in-app updates | Supported |
| macOS | `pnpm package:mac`, local build | No release yet |
| Linux | Manual workflow (AppImage, deb) | No release yet |

`orbit-msg` reports are Windows only. Elsewhere the planner reads the worker's pane.

</details>

## Build from source

```powershell
git clone https://github.com/aiedwardyi/Wink.git
cd Wink
pnpm install --frozen-lockfile
pnpm dev:desktop    # the desktop app
pnpm dev            # or the browser UI at http://127.0.0.1:5199
pnpm package:win    # installer in release/
```

## Troubleshooting

<details>
<summary>SmartScreen, missing engines, worker reports, phone link, updates</summary>

**SmartScreen blocks the installer**
The installer isn't code-signed yet. Choose **More info**, then **Run anyway**.

**An engine shows as missing**
Install its CLI, run its sign-in command once in a terminal, then check **Settings > Connections**.

**Worker reports never arrive**
`orbit-msg` is installed on Windows only. Check that the card's last line runs `orbit-msg --report DONE|FAIL|BLOCKED <NICK>`. On macOS and Linux the planner reads the pane instead.

**No phone link in Settings**
The **Phone link** card shows once Tailscale is installed and logged in on this PC, and no other `tailscale serve` rule holds its port 443.

**Wink is on an old version**
Updates are checked hourly. Press the update button when it appears, or download the latest [Wink-setup.exe](https://github.com/aiedwardyi/orbit-releases/releases/latest/download/Wink-setup.exe).

</details>

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

If Wink is useful to you, a star helps others find it.

## Credits

Wink is designed, built and maintained by [Edward Yi](https://github.com/aiedwardyi).

Its first codebase came from [OpenMausBot](https://github.com/milind-soni/OpenMausBot) by Milind Soni (Apache-2.0), used as a starting template. Since then, more than 1,100 commits have turned it into Wink. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The cross-model picker uses [Ghostex](https://github.com/maddada/Ghostex) by Mohamad Yahia (MIT) as its design source.

## License

Apache-2.0
