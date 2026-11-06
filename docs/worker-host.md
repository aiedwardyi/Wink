# Worker host

`WINK_WORKER_HOST=1` opts new worker panes into a detached host. Ordinary terminal
shells retain their existing ownership. The default remains off.

The Windows host keeps the existing PTY threads, worker admission, session capture,
screen model and cleanup guards. Closing or crashing the main app disconnects the
window. Reopening adopts the same panes without launching or admitting them again.
Explicit pane close keeps its existing meaning. An empty host exits itself.

## Ownership

- Discovery lives in `userData/worker-host`, with access restricted to its owner.
- A random pipe name and secret identify one host nonce, PID, creation time and boot.
- Before publication, the pipe ACL admits the current user and denies network logons.
- Protocol v1 negotiates capabilities before accepting operations. A snapshot's
  sequence separates its screen replay from subsequent output.
- Runtime code, executable, DLLs and node-pty are copied into an immutable directory
  outside the app install. Existing live hosts keep their original copy.
- Unreadable, unreachable or incompatible hosts produce `Background work unavailable`.
  Their processes and runtime remain untouched. Recovery requires confirmed death.
- Discovery and adoption precede the existing exact-ID recovery. Reattachment retains
  its admitted account; new launches still use the current account policy.

## Verification

Run the RAM gate, then the named tests:

```powershell
node --test electron/worker-host.node-test.mjs electron/terminal-host.node-test.mjs electron/terminal-bridge.node-test.mjs electron/worker-resume.node-test.mjs electron/packaged-imports.node-test.mjs
pnpm typecheck
git diff --check
```

The host tests use isolated synthetic shells. They check the real pipe ACL, failed
handshakes, process identity, screen/cursor replay, once-only input and empty exit.
Update coordination, durable report delivery and cleanup handoff remain a later slice.
This opt-in is not an update-survival guarantee.

Windows proof on 2026-11-06 passed X-close and actual-main crash/reopen with an
unchanged worker PID, creation time and boot identity. Screen/cursor restoration,
once-only input and five adopted panes were checked in an isolated xterm renderer.
The named checks cover 479 tests; app/server typechecks passed.

Performance acceptance remains blocked. The shared machine did not provide sixty
quiet seconds below fifteen percent CPU. Interrupted timing runs are diagnostic,
and do not establish a speed comparison. Window-frame acceptance remains unverified.
All future proof windows must remain hidden or use actual offscreen rendering.
