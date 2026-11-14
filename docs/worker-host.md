# Worker host

Bot terminals on Windows run inside a small hidden process, the worker host, instead of inside the Wink app.
The host is the base for keeping workers alive through an app update. Today nothing changes for users: quitting
Wink still closes every pane. macOS and Linux keep the in-app terminal path.

## Shape

| File | Role |
|---|---|
| `electron/worker-host-entry.mjs` | The host: one named pipe, one terminal per pane, a 256 KiB output ring per pane. |
| `electron/worker-host-client.mjs` | The app side: finds or starts the host and hands `terminal-host.mjs` a terminal handle. |
| `electron/worker-host-protocol.mjs` | Protocol 1: frames, the hello proof, the request and reply plumbing. |
| `electron/worker-host-runtime.mjs` | Copies the runtime out of the install folder and starts the host from the copy. |
| `electron/worker-host-identity.mjs` | The lock file that says a host is alive, and its record files. |
| `electron/spawn-gate.mjs` | Keeps the host's launch out of the moment a terminal starts. |

The host knows nothing about bots, accounts, mail, cleanup or the phone. Those stay in `terminal-host.mjs`, which
treats a hosted pane like any other terminal: the handle has the same members as `terminal-pty.mjs` plus `detach()`.
The only seam is the `hostPty` option of `createTerminalHost`.

## Start and stop

- The app calls `prewarm()` once the server is up. Opening a pane never waits for the host: a pane asked for
  before the host is connected opens in the app as before.
- The host runs from `%LOCALAPPDATA%\Wink\worker-host` (`Wink-dev` for an unpackaged app): `bin-*` holds the renamed
  executable and node-pty, `js-*` holds the five scripts. A layer is copied once, in a worker thread, and reused
  until its key changes. The host refuses to start from inside the install folder, which an update replaces.
- While a terminal starts, Windows marks its console pipes as inheritable for a few milliseconds. A process created
  in that moment keeps a copy, and the terminal then never ends. `spawn-gate.mjs` makes the host's launch wait for
  terminals that are starting, and makes a terminal wait for a launch in flight. The launch first runs the copied
  executable once with `--version`, so the slow first start of a new copy is over before the gate is taken.
- State lives in `<userData>\worker-host\v1`: `host.lock` (held while the host lives), `host.json` (pipe and
  secret), `panes.json` (id, pid, times, exit code and bot id per pane; no environment), `host-errors.log`.
- The host exits half a second after its last pane is gone with no app connected.

## Protocol 1

Frames are a 4 byte length, a type byte and a payload, 256 KiB at most. Control frames are JSON; terminal output
and input travel as binary frames with the pane id, and output carries a sequence number.

- Hello: the app sends a nonce, the host answers with its own nonce and a proof, the app proves itself back. Both
  proofs are HMACs over the secret in `host.json`. A caller that fails gets no reply and is dropped. At most four
  callers may be mid-hello, each for five seconds.
- Verbs: `list`, `spawn`, `attach`, `resize`, `kill`, `forget`, `detach`. Events: `ready`, `exit`, `gone`, `fenced`.
- One controller at a time. A newer one fences the older, whose requests then fail.
- `attach` takes the last sequence number the app saw and replays the ring after it, then streams live output. The
  reply says when older output was already dropped.
- A controller that did not send the `adopt` capability takes its panes with it when it leaves. The app does not
  send `adopt` yet.

## Fallback

A pane opens in the app, exactly as before, when the host is missing, speaks another protocol, does not answer
within two seconds, or is full (64 panes, or two older hosts still running). Each reason is logged once per run as
`worker host <reason> (<detail>): panes open locally`. A pane already running in a host that dies ends with an
error, as it does today when its terminal thread dies.

## Tests

```sh
node --test electron/worker-host.node-test.mjs
node --test electron/worker-host-runtime.node-test.mjs
node --test electron/worker-host-panes.node-test.mjs
```

They start real hosts and real shells under a temp folder and check that every host ends by itself.

## Not built yet

Keeping panes through a quit or an update, finding them again at start, and removing the runtime copy on
uninstall. `attach()` on the client and `createSession()` in `terminal-host.mjs` are the entry points for that work.
