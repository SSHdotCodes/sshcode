# Evals

Development-only model evaluations for SSHCode-owned instructions and MCP tools. They never run in the app or in CI. Unit tests exercise the runner and graders without model calls.

Start with [MCP tool use](mcp-tool-use/README.md). Cases are synthetic `.ndjson`; captured templates contain no account credentials or user instructions. Keep paid-run results and request captures outside the repository.

When changing agent-facing text, save a baseline before editing it, compare the same cases and models afterwards, and reject regressions. A smaller context is useful only when tool-use quality holds up.
