// Every limit Wink keeps over the user or a bot, and the crash, data loss or runaway loop it prevents.
// server/limits.test.ts fails on a MAX_* number or refusal string ("at most", "limited to", "keeps N") missing here.
// Keys are file -> text found in the constant name or string -> why.
type Limits = Readonly<Record<string, Readonly<Record<string, string>>>>;

const BODY = "Crash: request body size; one oversized request would exhaust memory.";
const FILE = "Crash: the file is read whole into memory.";
const OUTSIDER = "Security: bounds what an outsider (relay peer, pairing attempt, untrusted file) can make Wink hold.";
const TOKENS = "Runaway loop: this text rides every turn, so it bounds prompt tokens per turn. Clipped, never refused.";
const AUTO = "Runaway loop: automatic model calls or checks with nobody asking.";
const STATE = "Data loss: internal history or cache that would grow without end; nothing is refused.";
const DISPLAY = "Display only; nothing is refused.";
const JOINER = "Crash: shipped joiner builds fail to parse the whole room past this (guest-client.ts state schema), so every joiner goes blank and offline.";
const PROMPT = "Prompt wording that guides the model; nothing is refused.";

/** Real limits, kept on purpose. */
export const KEPT_LIMITS: Limits = {
  "electron/brand-override.mjs": { MAX_IMAGE_BYTES: FILE },
  "electron/cua-linux.cjs": { "limited to GNOME": "Capability: only GNOME exposes the portal desktop control needs; not a permission." },
  "electron/error-reports.mjs": { MAX_BYTES: STATE },
  "electron/terminal-bridge.mjs": { MAX_SEND_BODY: BODY, MAX_INPUT_BODY: BODY },
  "electron/terminal-screen.mjs": { MAX_ROWS: FILE, MAX_COLS: FILE, MAX_CELL_TEXT: FILE, MAX_SCREEN_RUNS: FILE },
  "electron/update-trace.mjs": { MAX_BYTES: STATE },
  "electron/worker-host-client.mjs": { MAX_PANES: "Crash: each hosted pane holds a terminal thread and output buffers.", MAX_OTHER_HOSTS: "Runaway loop: updates must not leave an unbounded number of live background hosts." },
  "electron/worker-host-entry.mjs": { MAX_PANES: "Crash: each hosted pane holds a terminal thread and output buffers.", MAX_UNAUTHENTICATED: OUTSIDER },
  "electron/worker-host-protocol.mjs": { MAX_FRAME: BODY, MAX_CHUNK: "Crash: UTF-8 expansion must fit the protocol frame.", MAX_BACKLOG: "Crash: a stalled pipe reader must not accumulate unbounded buffered output." },
  "server/account-notice.ts": { MAX_LABELS: DISPLAY },
  "server/auto-review.ts": { MAX_REVIEW_REASON_CHARS: TOKENS, MAX_REVIEW_FIELD_CHARS: TOKENS },
  "server/avatar-image.ts": { MAX_UPSTREAM_RESPONSE_BYTES: FILE },
  "server/bot-directory.ts": { MAX_DIRECTORY_BYTES: FILE, MAX_DIRECTORY_BOTS: FILE },
  "server/bot-profile.ts": { "name must be at most": BODY, "title must be at most": BODY, "voice must be at most": BODY },
  "server/bot-routes.ts": { "section must be at most": BODY, "prompt must be at most": BODY },
  "server/comms-root.ts": { MAX_IDLE: STATE },
  "server/composio.ts": { MAX_AUTH_CONFIG_PAGES: "Runaway loop: paging a provider list that never ends.", MAX_CONNECTED_ACCOUNT_PAGES: "Runaway loop: paging a provider list that never ends." },
  "server/computer-control.ts": { MAX_REASON_CHARS: DISPLAY },
  "server/config.ts": { MAX_ROOM_TURN_TIMEOUT_MINUTES: "Crash: setTimeout overflows past 24.8 days and fires at once." },
  "server/connector-proxy.ts": { MAX_RESPONSE_BYTES: FILE },
  "server/context-compaction.ts": { MAX_CONTEXT_MESSAGES: TOKENS, MAX_TAIL_MESSAGES: TOKENS, MAX_SUMMARY_TOKENS: TOKENS },
  "server/decision-log.ts": { MAX_BYTES: STATE },
  "server/delegation-ledger.ts": { MAX_AGE: STATE },
  "server/device-sync.ts": { MAX_DEVICE_FILES: STATE },
  "server/drivers/phone-proxy.ts": { MAX_ADB_OUTPUT: FILE },
  "server/drivers/side-hook.cjs": {
    MAX_READS: "Data loss: the quick side answer runs beside the live turn in the same folder; HANDOFF gives the full turn.",
    "Read, Glob or Grep, at most 3": PROMPT,
  },
  "server/early-listen.ts": { MAX_QUEUED_EARLY_REQUESTS: "Crash: requests buffered before the server is up are held in memory." },
  "server/group-routes.ts": {
    "channel name must be at most": BODY,
    "context must be at most": BODY,
    "bulletin must be at most": BODY,
    "room name must be at most": BODY,
    "section must be at most": BODY,
  },
  "server/index.ts": {
    MAX_COMMS_DEPTH: "Runaway loop: the bot-to-bot reply-loop guard; a peer turn cannot ask or delegate another hop.",
    "voice utterances are limited to": BODY,
  },
  "server/installed-playbooks.ts": { MAX_SELECTED: TOKENS, MAX_RENDERED_CHARS: TOKENS },
  "server/internal-routes.ts": {
    "message chains are limited to one hop": "Runaway loop: the bot-to-bot reply-loop guard (MAX_COMMS_DEPTH).",
    "setup.bulletin must be at most": BODY,
    "channel name must be at most": BODY,
  },
  "server/key-broker.ts": { MAX_RESPONSE_BYTES: FILE, MAX_UPLOAD_FILE_BYTES: FILE, MAX_UPLOAD_BYTES: FILE },
  "server/memory-lookup.ts": { MAX_ROWS: TOKENS, MAX_CHARS: TOKENS, MAX_CORPUS_BYTES: FILE, MAX_TERMS: TOKENS, MAX_WORD: TOKENS },
  "server/memory-pass.ts": { MAX_PASSES: AUTO, MAX_PENDING: AUTO },
  "server/openmaus-status-capsule.ts": { MAX_CACHE_BYTES: FILE },
  "server/phone-access.ts": { MAX_BODY_BYTES: BODY },
  "server/phone-devices.ts": { MAX_PAIRING_ATTEMPTS: OUTSIDER, MAX_CREDENTIAL_LENGTH: OUTSIDER },
  "server/phone-google.ts": { MAX_CHALLENGES: OUTSIDER },
  "server/phone-relay/acme.ts": { MAX_POLLS: "Runaway loop: polling a certificate order that never settles.", MAX_RESPONSE_BYTES: OUTSIDER },
  "server/phone-relay/client.ts": { MAX_POOL: OUTSIDER, MAX_PARALLEL_OPENS: OUTSIDER },
  "server/phone-relay/enroll.ts": { MAX_INVITE_LENGTH: OUTSIDER },
  "server/phone-relay/ingress.ts": { MAX_PENDING_PER_PEER: OUTSIDER, MAX_PEER_LENGTH: OUTSIDER },
  "server/phone-relay/store.ts": { MAX_KEY_HISTORY: STATE },
  "server/phone-visits.ts": { MAX_VISITS: DISPLAY },
  "server/project-folder.ts": { MAX_SEARCH_CHILDREN: "Crash: walking an unknown folder tree; the search is a suggestion only." },
  "server/project-scout.ts": {
    MAX_FILE_BYTES: FILE,
    MAX_DIR_ENTRIES: "Crash: walking an unknown folder tree; the scout only suggests.",
    MAX_SUGGESTED_SPECIALISTS: DISPLAY,
  },
  "server/quick-route.ts": { MAX_CHARS: TOKENS },
  "server/quorum-route.ts": { MAX_DAYS: OUTSIDER },
  "server/replies.ts": { MAX_REPLY_EXCERPT: TOKENS },
  "server/room-lane.ts": { MAX_ROOM_LANES: "Crash: each lane is another engine process; extra turns wait, never refused." },
  "server/rooms/door-streams.ts": { MAX_BACKLOG_BYTES: OUTSIDER },
  "server/rooms/door.ts": { MAX_STREAMS: OUTSIDER },
  "server/rooms/invites.ts": { MAX_CREDENTIAL_LENGTH: OUTSIDER, MAX_PEOPLE: `${JOINER} 100 people loaded, 101 went blank (measured).` },
  "server/routines.ts": { MAX_RUNS: STATE },
  "server/self-wake.ts": { MAX_AHEAD_MS: AUTO },
  "server/shell-made.ts": {
    MAX_ENTRIES: "Crash: named folders and the new folders in them are listed on the event loop after each shell command; a huge folder would stall the server. It bounds the entries a command left untouched in a named folder and the size of a new folder tree; past it the folder itself is kept when anything in it changed, never a short list. Nothing is refused.",
    MAX_TOKENS: "Crash: each path a command names costs a stat per folder named before it, on the event loop; a long script would stall the server. It also bounds those folders. Nothing is refused.",
  },
  "server/side-chat.ts": {
    MAX_MS: "Data loss: the quick side answer runs beside the live turn; HANDOFF gives the full turn.",
    MAX_CHARS: "Data loss: the quick side answer runs beside the live turn; HANDOFF gives the full turn.",
  },
  "server/summary-build.ts": { MAX_BUILD_RUNS: AUTO },
  "server/summary-repair.ts": { MAX_REPAIR_RUNS: AUTO, MAX_REPAIR_BATCHES: AUTO },
  "server/task-asks.ts": {
    MAX_STATUS_ASKS_BYTES: "Crash: bots see every open ask, so the turn must still fit the model's input; past this size the least recently shown go first and the header counts the rest for the next turn. Nothing is refused or dropped.",
  },
  "server/team-library.ts": { MAX_CATALOG_BYTES: OUTSIDER, MAX_MANIFEST_BYTES: OUTSIDER },
  "server/thread-events.ts": { MAX_LIMIT: FILE, MAX_TAIL_BYTES: FILE },
  "server/thread-sync-v2-engine.ts": { "Sync batches are limited to 128 changes": "Crash: one sync transaction size across PCs." },
  "server/thread-sync-v2.ts": { "Sync batches are limited to 128 changes": "Crash: one sync transaction size across PCs." },
  "server/uploads.ts": { MAX_NAME_CHARS: "Crash: Windows path length for the saved file name; the name is shortened, never refused." },
  "server/verify-app.ts": { MAX_URLS: AUTO },
  "server/verify-doc.ts": { MAX_BYTES: "Crash: the whole document zip is parsed in memory." },
  "server/verify-site.ts": { MAX_FILES: FILE, MAX_FOLDERS: FILE, MAX_FILE_BYTES: FILE, MAX_SITE_BYTES: FILE },
  "shared/google-id-token.ts": {
    MAX_TOKEN_CHARS: OUTSIDER,
    MAX_MAX_AGE_SEC: "Security: a provider's cache header cannot pin Google's signing keys for longer than a day.",
  },
  "shared/reactions.ts": { MAX_REACTION_MESSAGES: TOKENS, MAX_REACTION_EXCERPT: TOKENS },
  "shared/redact.ts": { MAX_DEPTH: "Crash: recursion on a nested object; a deeper part is redacted, never sent." },
  "shared/relay-protocol.ts": { MAX_FRAME_BYTES: OUTSIDER },
  "shared/tls-client-hello.ts": { MAX_CLIENT_HELLO_BYTES: OUTSIDER, MAX_RECORD_PAYLOAD: OUTSIDER },
  "src/components/TeamLibraryPanel.tsx": { MAX_TEAM_FILE_BYTES: BODY },
  "src/lib/big-upload.ts": { MAX_FAILURES: "Runaway loop: retrying a chunk that keeps failing." },
  "src/lib/chat-image.ts": { MAX_W: DISPLAY, MAX_H: DISPLAY, MAX_SIZES: STATE },
  "src/lib/chat-options.ts": { MAX_OPTIONS: DISPLAY, MAX_OPTION_LEN: DISPLAY },
  "src/lib/companion-pairing.ts": { MAX_HOSTS: "Crash: the pairing QR code overflows." },
  "src/lib/live-call/controller.ts": { MAX_RECONNECTS: "Runaway loop: reconnecting a call that keeps dropping.", MAX_NUDGES: AUTO },
  "src/lib/map-highlight.ts": { MAX_LINES: DISPLAY, MAX_CHARS: DISPLAY },
  "src/lib/room-turn-timeout.ts": { MAX_ROOM_TURN_TIMEOUT_MINUTES: "Crash: setTimeout overflows past 24.8 days and fires at once." },
  "src/lib/verify-replay.ts": { MAX_CHUNK: FILE },
  "src/state/store-transforms.ts": { MAX_CONSUMED_QUEUE_IDS: STATE, MAX_KEPT_SCREEN_FRAMES: "Crash: screenshots held in browser memory." },
};

/** Wording a model reads; it guides, it refuses nothing. */
export const PROMPT_WORDING: Limits = {
  "server/computer-proxy.ts": { "at most three bounded checks": PROMPT },
  "server/drivers/agents-proxy.ts": {
    "recheck at most twice": PROMPT,
    "durable outcome, at most 500 characters": TOKENS,
    "concise plan, at most 20 steps": TOKENS,
    "At most 200 characters.": TOKENS,
    "actually complete, at most 300 characters": TOKENS,
    "next useful action, at most 300 characters": TOKENS,
    "Current blockers, at most 10": TOKENS,
    "At most 300 characters.": TOKENS,
    "task created, at most 20": TOKENS,
    "file path, at most 500 characters": TOKENS,
    "few words, at most 80 characters": TOKENS,
    "points to, at most 80 characters": TOKENS,
  },
  "server/drivers/team-report-tool.ts": { "at most eight": PROMPT },
  "server/index.ts": { "at most one short activity line": PROMPT },
  "server/live-call.ts": { "two at most": PROMPT, "in at most two short sentences": PROMPT },
  "server/side-chat.ts": { "at most 3 Read, Glob or Grep": PROMPT },
  "server/task-asks.ts": { "ask the user about at most 3": PROMPT },
  "server/team-report-evidence.ts": { "(at most 8)": PROMPT },
  "server/verify-doc-text.ts": { "at most 8 words": PROMPT, "At most 12 findings": PROMPT },
  "server/verify-message.ts": { "at most twice": PROMPT },
  "server/workspace.ts": { "300 bytes at most": PROMPT },
};

/** Limits other cards own or a follow-up removes; delete the entry with the limit. */
export const PENDING_LIMITS: Limits = {
  "server/bot-routes.ts": { "this workspace is limited to": "Owned by CREATE-BOT-OPEN (workspace bot cap)." },
  "server/index.ts": { MAX_WORKSPACE_BOTS: "Owned by CREATE-BOT-OPEN (workspace bot cap)." },
  "server/internal-routes.ts": {
    "this workspace is limited to": "Owned by CREATE-BOT-OPEN (workspace bot cap).",
    "name must be at most 80": "Owned by CREATE-BOT-OPEN (create-bot route).",
    "role must be at most 120": "Owned by CREATE-BOT-OPEN (create-bot route).",
    "instructions must be at most 1000": "Owned by CREATE-BOT-OPEN (create-bot route).",
  },
  "server/rooms/files.ts": { MAX_MESSAGE_FILES: "Follow-up after ROOM-COLLAB-OPEN: 50 files per room message.", "at most ": "Follow-up after ROOM-COLLAB-OPEN: MAX_MESSAGE_FILES refusal." },
  "server/rooms/send.ts": { "at most ": "Follow-up after ROOM-COLLAB-OPEN: MAX_MESSAGE_FILES refusal for the host's attached files." },
  "server/rooms/guest-client.ts": { MAX_VIEW_ENTRIES: "Parked for Edward: caps the user's own view of a joined room at 10,000 local rows; not host input." },
  "server/rooms/upload-timeouts.ts": { MAX_UPLOAD_BYTES: "Follow-up after ROOM-COLLAB-OPEN: mirrors the 1 GB room file cap." },
  "server/team-manifest.ts": {
    MAX_TEAM_MEMBERS: "Owned by CREATE-BOT-OPEN (bot count from an imported team).",
    "A team can have at most": "Owned by CREATE-BOT-OPEN.",
    MAX_MEMBER_NAME: "Owned by CREATE-BOT-OPEN.",
  },
  "src/lib/team-rooms.ts": { MAX_ROOM_FILES: "Follow-up after ROOM-COLLAB-OPEN: mirrors MAX_MESSAGE_FILES." },
};

/** Guards the scan cannot see by shape; the test checks each still exists. */
export const NAMED_GUARDS: Limits = {
  "electron/terminal-host.mjs": { "Ctrl+C is not allowed": "Never interrupts a running worker: a confirmed send cannot carry Ctrl+C into a live pane." },
  "server/terminal-snapshot.ts": { "Ctrl+C is not allowed": "Never interrupts a running worker: the remote terminal box cannot paste Ctrl+C into a live pane." },
  "server/index.ts": {
    chainEdge: "Runaway loop: the room reply-loop guard; each bot-to-bot mention pair runs once per human message.",
    MAX_COMMS_DEPTH: "Runaway loop: the bot-to-bot reply-loop guard.",
  },
  "server/comms-root.ts": { ROOT_TURNS: "Runaway loop: bot-to-bot turns after one human message; resets on the next one." },
  "server/drivers/claude.ts": {
    NATIVE_IMAGE_MAX_COUNT: "Crash: past 20 image blocks the Claude API rejects the request on its many-image dimension limit (vision docs); later images stay path tags the bot can Read.",
  },
  "server/rooms/db.ts": { ROOM_TEXT_MAX: `${JOINER} A 20,001-character line was dropped for live joiners (measured).` },
  "server/rooms/my-room-bots.ts": { "Room Stop": "The room Stop button: bot lines wake no bot until a person or the host speaks." },
  "server/http-helpers.ts": { "413": BODY },
  "server/uploads.ts": { disk_full: "Data loss: a big upload that would fill the disk." },
  "server/backup.ts": { BACKUP_FILE_LIMIT: "Data loss: backup walks whole bot workspaces (repos, build output); huge files would fill the disk." },
  "server/task-state.ts": { TASK_STATE_READ_MAX_BYTES: FILE },
};
