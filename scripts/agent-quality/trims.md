# Agent context trims

Measured with `node scripts/agent-quality/report.ts`. UTF-8 bytes, not billed tokens.

The largest available context sources before trimming were:

| Source                                   |  Bytes | Decision                                                                                                                                                                     |
| ---------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent MCP output schemas                 | 62,912 | Keep branch constraints and field meanings. Shared schema references could reduce repetition, but provider code-mode rendering needs an eval before changing representation. |
| Agent MCP input schemas and descriptions | 59,448 | Remove an identical `allOf` annotation; shorten three browser descriptions. Keep every tool and all orchestration mechanics.                                                 |
| Full MCP catalog                         | 89,249 | Separate catalog measurement, overlapping the agent catalog. Do not hide tools to save context.                                                                              |
| Shared orchestration instructions        |  6,322 | Keep decision rules intact.                                                                                                                                                  |
| ACP bootstrap                            |  7,362 | Keep mode, orchestration, transport fallback and runtime blocks. Repeated unchanged turns already add zero instruction bytes.                                                |

These are overlapping views, not an additive total. Replay metrics separately expose actual repeats, wake/notification bytes and tool output. Repeated content across a fresh or resumed context can be necessary; repetition alone does not justify deleting it.

The schema audit also measures **14,024 bytes of exact repeated output-schema bodies** beyond the first copy, plus **4,797 bytes of exact repeated schema descriptions** after the trims (4,919 before). Browser status outputs alone are 3,129 bytes per tool. These are larger candidates than the implemented wording changes, but repeated type information can still help a provider interpret each tool independently. Both audit metrics are included in the build gate.

## Implemented

| Change                                                                     |     Before |      After |           Saved |
| -------------------------------------------------------------------------- | ---------: | ---------: | --------------: |
| `preview_status` description                                               |        587 |        397 |             190 |
| `preview_open` description                                                 |        800 |        652 |             148 |
| `preview_snapshot.includeImage` input schema guidance                      |      1,305 |      1,270 |              35 |
| `preview_evaluate` input schema, identical description-only `allOf` branch |        982 |        831 |             151 |
| **Agent MCP list JSON**                                                    | **59,448** | **58,924** | **524 (0.88%)** |
| Full MCP list JSON                                                         |     89,249 |     88,725 |             524 |

The snapshot row measures its complete input schema. Only the `includeImage` wording changed. Status still describes ownership, tab selection, profiles and read/action permissions. Open still describes chart routing, inline/background preview, tab reuse, parallel subagent isolation, saved logins and other-session access. Image inclusion still defaults to false and is for visual inspection. The removed schema annotation duplicated the exact parent text and imposed no constraint. Tests compare accepted/rejected values and preserve distinct guidance and `allOf` constraints.

`agentContextBudget.json` now records the smaller tool catalogs and adds Cursor (6,427 bootstrap bytes, zero repeated-turn overhead) and OpenCode (6,324 system bytes). Claude, Codex and ACP instruction wording and budgets did not change. Output schema bytes stayed at 62,912. No tool was removed, renamed, hidden, or made unavailable to subagents.

## Deferred

- Deduplicate the repeated browser status output object (3,129 bytes per tool). A `$ref` representation needs provider rendering/behavior coverage first.
- Compact the repeated numeric/special-value unions. They encode `Infinity`, `-Infinity` and `NaN`; dropping branches changes meaning.
- Change OpenCode 1's repeated system field only after checking its SDK/session retention contract. An identical field on the wire does not prove repeated model context.
- Trim wake summaries only with replay and live task-outcome evidence. The fixture measurements alone cannot establish which completion details an agent needs.

Byte reductions are not semantic quality improvements. Live trends are observational, with explicit unknowns and sample caps; provider/model task mix can change between builds.
