# Live efficiency sample

`readLiveReport(options?: LiveReportOptions): LiveReport` is synchronous. `renderLiveMarkdown(report): string` emits aggregates only. Run `node scripts/agent-quality/live.ts [--db PATH] [--days 1..31] [--json]`. The default database is `~/.t3/userdata/statev2.sqlite`, with a seven-day half-open window ending now. The API also accepts `now: Date` and the budgets below.

The connection uses `mode=ro&immutable=1`, `readOnly: true`, extensions disabled, and connection-local `query_only`. It does not write the database, WAL, or SHM. **This reads the checkpointed main file, ignoring WAL.** It can lag live activity. Immutable readers assume the main file stays stable; a concurrent checkpoint may invalidate a run. Retry later if SQLite fails. This is deliberately a bounded observational sample, not a complete or transactionally consistent live census.

## Metrics

- A task is one completed delegated subagent record that both started and completed inside the window. Discovery uses recently active parent threads. App-owned runs must explicitly name its `delegatedTaskId`; child-thread reuse does not attribute unrelated work. Native tasks use their provider thread within the task interval. Nested task records are separate tasks, not parent totals.
- Grouping uses recorded run provider/model, falling back to task metadata. Multiple models/providers become `mixed`; missing labels become `unknown`. No per-run SSHCode server version exists in the supported schema, so version grouping is unavailable. A current installation version would not be a valid historical substitute.
- Tokens are summed `inputTokens + outputTokens` from **complete** `main_agent` `turnTokenUsage` for every attributed provider turn. Cache/reasoning subsets are already included, and nested agents are excluded. Context occupancy (`tokenUsage.usedTokens`) is never consumption. Partial, missing, malformed, unsafe-integer, or incompletely sampled totals are unknown, never zero.
- Turns count persisted attributed provider turns, including failed attempts. Missing attribution/turns and capped partitions are unknown. Median uses the middle value or the mean of the middle pair; p90 is nearest-rank. Each distribution gives known and unknown task counts.
- Fix rounds are a **heuristic proxy**: `max(0, completed attributed runs - 1)` per task. Extra runs can be follow-up work rather than fixes. Native tasks without app run attribution are unknown.
- Final prose-offer rate is an **English heuristic** over the last paragraph (up to 2,000 characters) of the last non-streaming assistant turn item in the final completed run, or the native task result. It looks for phrases such as “I can”, “want me to”, and “if you'd like”. Quoted text and negation can produce false positives. The denominator includes tasks with a readable final and uncapped item/run partitions; unavailable finals are unknown.
- MCP error rate groups identifiable MCP `dynamic_tool` items by tool name. A failed status or structured `output.isError=true` is an error; completed status otherwise counts as success. Interrupted, cancelled, and nonterminal outcomes are unknown and excluded from the denominator. Unrecognized tools, missing payloads, and capped item partitions are omitted, so this is a sampled-call rate. Calls are deduplicated by item ID within each group. Arguments, outputs, bodies, IDs, paths, and prompts never appear in the report.
- Daily trends group by UTC completion date. No task-complexity normalization or causal model-quality claims are made.

## Work bounds

No global time index exists for tasks/runs. Discovery reads a **sequence span**, not a time-filtered scan of the event log. Every data statement is checked with `EXPLAIN QUERY PLAN` before execution: existing-index searches only, no application-table scans, automatic indexes, or temporary sorts. Scans of the explicitly materialized, capped intermediate `bounded` rows are allowed. Metadata inspection is a fixed six-name `sqlite_schema` query. The one high-water lookup uses a primary-key seek and `LIMIT 1` without a time predicate.

| API budget                                              |    Default |    Maximum |
| ------------------------------------------------------- | ---------: | ---------: |
| `maxEvents` (sequence span)                             |     50,000 |    200,000 |
| `maxThreads`                                            |         64 |        256 |
| `maxTasksPerThread`                                     |         64 |        256 |
| `maxRowsPerQuery` (runs/attempts/turns/items partition) |        256 |      1,024 |
| `maxQueries` (executed data statements)                 |      2,000 |      5,000 |
| `maxPayloadBytes` (UTF-8 bytes per JSON payload)        |     65,536 |    262,144 |
| `maxTotalPayloadBytes` (parsed JSON bytes)              | 33,554,432 | 67,108,864 |

Task queries seek `(thread_id, started_at)` and apply time bounds plus LIMIT. Other queries take the newest capped rows through the partition's existing index **before** applying time filters; attempts inherit the time-selected run boundary. This bounds examined rows even when timestamps are not indexed. SQL withholds payloads exceeding the byte cap before transferring JSON to JavaScript. No SQL JSON extraction traverses large payloads. The total parse budget is checked before each parse.

Coverage includes the sequence span, earliest sampled event, executed query count, parsed bytes, skipped payloads, and conservative cap flags. Reaching a partition limit marks it capped even if exactly that many rows exist. An old sequence boundary always marks discovery capped because timestamps can be nonmonotonic. A time window of seven days does **not** assert seven days of complete coverage. Missing expected indexes/schema fail closed; nothing creates or repairs them.
