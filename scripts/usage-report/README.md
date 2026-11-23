# Usage report

A read-only report on how lead models and subagents were used, computed from the app's SQLite state
database (`orchestration_v2_projection_threads` and `orchestration_v2_projection_runs`).

    node scripts/usage-report/cli.ts --db <path> [--days N] [--until <ISO time>] [--top N] [--json]

- `--db` (required): the state database, opened read-only. Point it at a copy, not the live
  `~/.t3/userdata/statev2.sqlite`.
- `--until` (default now) and `--days` (default 14): the window is `[until - days × 24h, until]`.
- `--top` (default 15): how many chats to list.
- `--json`: print the report as JSON instead of text tables.

It exits 2 with a one-line message for bad arguments, a missing `--db`, or an unreadable database.
Tests: `pnpm exec vp test run scripts/usage-report/`.

## What it shows

- **Totals**: lead chats with runs, how many of them started subagents, lead and subagent hours.
- **Lead models**: runs on lead chats per model, with chats, completed/failed/stopped counts and hours.
- **Subagent models**: tasks per model, median task minutes, duration buckets, follow-up runs per
  task and hours.
- **Top chats**: lead chats by lead hours, with their subagent tasks and concurrency.
- **Subagent tasks by day**: tasks and reviews per New York calendar day of task creation.

## Definitions

- Only runs whose `requested_at` falls in the window count.
- A **subagent thread** has `lineage.relationshipToParent = "subagent"` or an id starting with
  `thread:delegated-task:`; every other thread is a **lead chat**. A subagent's **root** is
  `lineage.rootThreadId`, else `lineage.parentThreadId`.
- A **task** is a subagent thread with at least one run in the window.
- A run's **model** is `modelSelection.model` (else `unknown`); its **minutes** are `completed_at`
  minus `startedAt` when both parse and are not negative, else 0.
- The **most frequent model** of a set of runs breaks ties by the latest run.
- **Stopped** means `cancelled` or `interrupted`.
- **Concurrency** of a chat: the summed minutes of its tasks' runs divided by the minutes covered by
  the union of those runs' intervals (0 when there are none). Above 1 means subagents ran in parallel.
- A **review** is a task whose title starts with "review", has " review" in its first 40 characters
  or "audit" in its first 30 (case-insensitive).
- Values are summed unrounded and rounded once: hours, median minutes and follow-ups to one decimal,
  concurrency to two.
