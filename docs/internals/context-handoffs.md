# Context handoffs

Portable provider and fork handoffs carry a selection of the app's own history, not native provider
context. They never reconstruct provider-native session state, tool state, approvals, or omitted
text.

## Selection happens twice

`ContextHandoffServiceV2` prepares a handoff inside the orchestrator's decision, where the target
model's context window is unknown: only a live session runtime reports it
(`getModelContextWindow`), or, for providers that report it after a turn, the projection's last
`contextUsage.maxTokens` for that instance. So preparation stores a selection at the largest size
(`MAX_HANDOFF_TOKEN_CAP`) and delivery in `ProviderTurnStartService` selects again at the target's
size (`scaledHandoffTokenCap`). `selectHistory` in `provider-core` owns the ranking for both.

`summaryText` is what agents read back for the handoff item, so it stays at the default size; the
stored selection lives in `history`. The wire projection removes `history`, `delivery`,
`summaryText` and the brief's text.

## The outgoing model's brief

A selection change that will hand off asks the outgoing session for a brief through
`askSideQuestion` (Claude's `/btw`), from the `provider-session.detach` effect the change already
emits. `HandoffBriefService` holds the answer in memory, keyed by thread and target, and defers that
detach until the brief is written or abandoned. Two consequences:

- The session stays live after the projection says it detached. Every turn start calls `settle`
  before opening a session: a brief for another target is ended and its session detached first, so a
  selection that returned to the outgoing provider cannot be detached under its new turn.
- A brief is lost on restart, and a brief nobody sent for is dropped after an hour. Delivery records
  the brief on the handoff so an ambiguous delivery that needs a fresh native thread carries it again.

A brief or workspace section is left out when it would take more than half the delivery budget, so
neither can fail a send.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs.
