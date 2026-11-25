# Live harness check

Run from an installed SSHCode worktree on macOS with Node 24 and the harness CLIs on PATH. The check uses the CLI sign-ins already available to that shell.

```sh
env -u ELECTRON_RUN_AS_NODE TMPDIR=/private/tmp node scripts/harness-check/run.mts
```

Pass a JSON output path as the first argument to change the default, `/private/tmp/harness-check-results.json`. The terminal and JSON report the same seven checks for each harness. A failed check exits with status 1, and Ctrl-C exits with status 130 after cleanup. Skipped checks carry their prerequisite or sign-in reason.

The check starts the worktree's server on a fresh loopback port with its own project and database under `/private/tmp`. It uses the client's WebSocket RPC contracts for project and thread creation, message delivery, Stop, projection, provider status and quota. The picker check uses the shared web and mobile picker catalog with no search, favorites, or preselected model.

Each harness uses an allowlisted inexpensive model and up to five tiny messages. The steering check observes a real foreground command before sending the follow-up and requires the answer in the same run. Stop must end a different foreground command and remove the observed OS process. After the isolated server restarts, the first follow-up must recall a random value from the first turn. Effort is checked on the reopened thread and the resumed run. An unavailable quota window is a failure with the published reason.

Keep the model allowlists conservative as catalogs change. The check never selects Qwen routes, forces Muse contributor mode off, disables automatic provider updates where supported, and leaves sign-in and credential handling to the existing harness integration. The test workspace, server state, and captured process tree are cleaned up on exit. The JSON report stays available.
