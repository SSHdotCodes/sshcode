# Agent quality measurements

From the repository root:

```sh
node scripts/agent-quality/report.ts
node scripts/agent-quality/report.ts --update-baseline
node scripts/agent-quality/live.ts
node scripts/agent-quality/live.ts --days 7 --json
```

The deterministic command runs the existing orchestrator replay fixtures, context budget tests and MCP service tests from `apps/server`, using fake providers and isolated state. It never starts SSHCode. The known hanging `grok_auto_blocked_command` case is explicitly skipped. Actual adapter content is observed before wildcard matching, so a recorded `<any>` cannot conceal growth. Non-metric replay variants still run their behavioral assertions. Missing scenario/tool coverage, new failures, or larger call/turn/repeat counts fail; each byte/token metric allows at most 3% growth. Updating a baseline is explicit and refused if measurement fails. The exact context-budget test must also match `apps/server/src/provider/agentContextBudget.json`.

JSON and Markdown reports go to `.generated/agent-quality/` (gitignored), or `--output-dir PATH`. Only numbers and fixture/tool identifiers are persisted; no prompts, results, credentials, host paths or images. A fresh temporary directory holds transient test results and is removed on exit. Timeout and signal handling stop the spawned test process group.

Bytes are UTF-8 content, and estimated tokens are `ceil(bytes / 4)`, not a provider tokenizer or billing count. Instructions, user prompts, app tool results, wakes and notifications are counted separately. The catalog is measured from current MCP registration, separately from replays: these fixtures do not exercise tool discovery. Recorded provider-native tool result estimates use final projected output, which can omit provider internals, and are reported separately from text SSHCode actually sends. Four current service-result probes cover running/completed `task_status` and two recovered-thread `t3_thread_read` paths. Their JSON payloads are measured once before MCP transport envelopes; they do not cover every tool result. Two delivery probes also measure actual held-update batching and idle-parent wake text from the current service. Wake classification matches complete payloads, so an instruction mentioning a completion marker is not mistaken for a delivered wake. Turns/tool calls are deduplicated projection entities, not streaming updates. Tool calls include tool-call nodes, subagent-launch nodes and todo-tool nodes. `persistedNotificationPayloads` is a separate stored-summary measure: a buffered provider wake can have stored text and zero actual app-send bytes. Repeated parts are candidates for review, including necessary rebootstrap into fresh contexts, not proven redundancy.

The live report is opt-in and never part of the release gate. It opens the real database immutable/read-only and executes bounded, existing-index-supported queries. Missing usage stays unknown. Fix rounds and English prose offers are explicitly labeled heuristics. See [live.md](live.md) for definitions, sampling limits and checkpoint/WAL caveats, and [trims.md](trims.md) for measured wording changes and deferred proposals.
