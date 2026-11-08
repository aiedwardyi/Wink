# How Wink works

## Engines and keys

- Local bots and workers use CLI sign-ins: Claude Code, Codex, Grok, Antigravity (Gemini, `agy`) and Meta Muse. They need no API key.
- The user picks each bot's engine, model and effort in the model picker (Alt+M, Open Model Picker). Switching keeps the chat: the new engine gets the conversation so far.
- Saved keys have separate uses:
  - xAI, Gemini, Claude and Vertex AI keys: `call_api` to that provider's own API.
  - OpenAI key: `generate_image`, bot avatars and `call_api` to `api.openai.com` (for example `/v1/responses`), subject to the key's access. Codex workers use the Codex sign-in.
  - ElevenLabs key: call voices and text-to-speech through `call_api`.
  - Box key: Cloud VM computer access and cloud routines, never `call_api`.
  - A custom key: `call_api` to the one host it was saved for.
- Reuse saved keys. Ask only for an API no signed-in engine can replace. "Ask Grok to search X" needs a Grok worker or teammate, not an xAI key.
- Saved keys show under Settings > Connections > Keys. The desktop app encrypts them on that PC; they do not sync.
- Sign in under Settings > Connections. Claude and Codex support multiple accounts; Usage > Set as Main chooses the default for bots and workers.
- If a worker pane shows a login prompt, tell the user that engine needs signing in. Do not ask for a key instead.

## Workers and teammates

- Worker panes: a bot with terminal tools starts engine CLIs in panes. The harness playbook covers how.
- Teammate bots: `list_bots` finds them. `ask_bot` waits up to 4 minutes, then returns a task ID for `wait_delegation` if still running. `delegate_bot` queues work until your turn ends; use `ask_bot` for replies needed this turn.
- Sections group bots (Move to section in a bot's menu). Each has at most one Chief of Staff (Make Chief of Staff in that menu), who coordinates and can create specialists.
- Groups are shared chats with several bots and the user (New group in the sidebar's + menu).

## Routines

- Use `list_routines` for this bot's routines, current time and timezone. `propose_routine` and `propose_routine_action` make cards; end the turn and wait for user confirmation before claiming a change.
- Wink must be running on the scheduling PC, including for cloud routines. Local routines use the bot's setup; cloud routines run in Box and need its key.

## Invited team report pilot

- On an authenticated team install, 에디에게 보내 at a sentence end in your own text outside quotes, code and pasted logs authorizes sending (spacing, 보네 typo and 줘/줘요/주세요/줄래/줄래요/요 endings allowed). Repeat after failed or unconfirmed delivery without a new attachment to reuse the report.
- Unrelated desktop capture and complete native logs are excluded.
- Receipts distinguish private service acceptance from local inbox filing. Bot reading is unverified. An offline or unsupported relay leaves a private local draft.

## Where things live

- Wink's data folder is `~/.orbit`.
- Local bot workspaces are `~/.orbit/workspaces/<bot id>`, with `MEMORY.md` and `memory/<topic>.md`.
- Chat attachments are in `~/.orbit/attachments`.
- Project Folder is picked in the bot's profile. `generate_image` saves in `generated-images`; `call_api` saves binary responses in `api-files`. Roots: task folder, Project Folder, then workspace.

## Sync and phone

- Sync is under Settings > Account. Google Sign-in syncs through a folder in the user's own Google Drive. Drive Folder syncs through a folder the user picks instead.
- What syncs: bot profiles, sections and their order, chats, memory and chat pictures. Project folders, computer permissions, routines, keys and engine sign-ins stay on each PC.
- If a chat changed on two PCs at once, Wink keeps both and the chat says "This chat also changed on another PC. Both versions were kept." A memory file edited on two PCs keeps the other copy beside it as `memory/<name>.conflict-<hash>.md`.
- The phone's browser reaches a PC running Wink and that PC's chats. Set it up under Settings > Phone using Tailscale, or the relay's Phone Access > Add a Phone pairing code. With sync on, the phone can switch between reachable PCs.

## Keyboard shortcuts

See Settings > Shortcuts on desktop. On a Mac, Alt is Option and Ctrl is Cmd.

- Alt+T: Toggle Themes. Alt+Shift+T: Cycle Theme.
- Alt+U: Quick Usage first when available, then all Usage.
- Alt+I: Toggle Model Index. Alt+Shift+I: Cycle Model Index Tab.
- Alt+M: Open Model Picker.
- Alt+W: Toggle Workers.
- Ctrl+`: Toggle Terminal.
- Ctrl+Enter: Queue Message (sends after the running turn).
