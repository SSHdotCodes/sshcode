# Context in portable handoffs

SSHCode transfers conversation context when you switch providers, continue through a portable
restart, or use a fork that the provider cannot resume itself.

Short conversations transfer intact. For longer conversations, SSHCode favors recent requests and
answers, the original request, and relevant activity such as command outcomes. Selected messages
keep their full text, order, and user or assistant role, including partial work from failed or
interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

The handoff includes references to omitted history. The agent can use SSHCode's thread-reading tool
to retrieve saved messages and activity, including the remainder of a long item. For an important
constraint, you can still repeat it in your next message.

## The previous model's brief

When you pick a model on another provider and the current one still has its session open (Claude
Code, for example), SSHCode asks it right away, in the background, for a brief of up to about 1,500
words: your goal and requirements, where things stand, decisions, what is done and verified, open
problems, the next step, pitfalls and the key files. The new model reads the brief first, then the
selected history. The brief never appears in the chat; the handoff row notes it ("with a brief from
…").

Send whenever you like. Your message waits up to about 20 seconds for a brief that is still being
written, then goes without it. Changing the model again before you send discards the brief.

The handoff also names the branch and worktree, summarizes uncommitted changes, lists the files the
chat changed, and lists background work, such as subagents and monitors, that was still running.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If even its retrieval references cannot fit, SSHCode reports an error
instead of shortening your request. Compact the target conversation or select a larger-context
model before trying again.

A handoff uses about a tenth of the new model's context window, between 32,000 and 192,000 bytes
(roughly 8K to 48K tokens), so a long chat reaches a large-context model in more detail. A provider
that reports its window only after a turn is sized by the window it last reported. Server operators
can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to use a fixed size instead (clamped to 1,024–192,000).
This is an upper bound, not a provider context-window guarantee. Text accounting conservatively
charges one token per UTF-8 byte, including attribution and JSON escaping. Your current input and
attachment payloads do not consume the handoff's allowance.

SSHCode uses available capacity information for your selected model and options, together with
provider context telemetry. Starting a fresh provider conversation clears prior usage, while keeping
known model capacity. Changing models or context-window options discards stale usage and compaction
thresholds.

When no capacity information is available, SSHCode assumes a 128,000-token window. It reserves at
least 16,000 tokens, or a quarter of the window when larger, for instructions, tools, and subsequent
work. Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references. Existing context is estimated from saved
activity when usage telemetry is unavailable. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.
