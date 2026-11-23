# MCP tool use

Replays synthetic threads against this checkout's instructions and MCP definitions. Cases cover upstream tool-use failures and SSHCode's question cards, catalog paging, superseded models, independent review ids, removed workspaces, monitors, schedules, keys, devices and cloud sessions.

## OpenAI-compatible API path

Use a saved key through SSHCode's `prepare_api_key`; execute its returned command with the runner as the child. Keys are read only from the named environment variable, never from harness homes, config files or other applications. The script does not load `.env` files.

```sh
node evals/mcp-tool-use/run.ts --model "$EVAL_MODEL" --shell-model "$SHELL_MODEL" \
  --effort low --concurrency 2 --surface all --out "$RESULTS/baseline"
node evals/mcp-tool-use/run.ts --model "$EVAL_MODEL" --shell-model "$SHELL_MODEL" \
  --effort low --concurrency 2 --surface all --out "$RESULTS/final" \
  --baseline "$RESULTS/baseline/results.jsonl" --stop-on-regression
```

Choose models from the endpoint's live `/models` list. The default base URL is OpenCode Go's `https://opencode.ai/zen/go/v1`, with `OPENCODE_GO_API_KEY`. Set `--base-url` and `--api-key-env` for another OpenAI-compatible endpoint. There is no CLIProxyAPI or gateway dependency. Claude models and Claude shell simulators are disabled; the Claude template remains available for offline dry runs.

The API path retains the captured Codex context and native tool definitions, translates their wire format to chat completions, and exposes current MCP definitions as native function tools. A restricted JavaScript VM simulates code-mode calls. Shell/file/web results use case mocks or a non-Claude shell simulator on the same endpoint. No generated shell command executes on the host. This is a portable approximation, not the installed harness.

Keep total concurrency modest across runs. Transient API failures back off. Each run writes results incrementally; `--resume` retains completed cases and moves provider/transport failures to `infrastructure.jsonl` before retrying them. Model tokens are recorded; subscription cost is not inferred from API list prices.

## Real Codex CLI path

```sh
node evals/mcp-tool-use/run.ts --runner codex-cli --model "$EVAL_MODEL" --effort xhigh \
  --surface all --concurrency 2 \
  --fixture-root "$FIXTURES" --out "$RESULTS/codex-baseline"
# After changing the checkout's owned text/tools:
node evals/mcp-tool-use/run.ts --runner codex-cli --model "$EVAL_MODEL" --effort xhigh \
  --surface all --concurrency 2 \
  --fixture-root "$FIXTURES" --out "$RESULTS/codex-final" \
  --baseline "$RESULTS/codex-baseline/results.jsonl" --stop-on-regression
```

This runs the installed `codex exec --ephemeral` against a loopback-only mock MCP server and a disposable fixture directory. It ignores user config, rules and plugins, and configures only the mock server. The mock serves the branch's model-facing names, descriptions and input schemas. Calls are recorded and answered from case mocks/default synthetic results. Model-facing schemas are real; mock results are partial fixtures, not full production-service responses.

`--sandbox read-only` permits reads outside the working directory. The runner instead supplies a command-line-only read-only permission profile: minimal system runtime paths plus the fixture are readable, writes and command networking are denied. A local probe must confirm inside reads succeed while outside reads and writes fail. No harness config file is edited. Fixture scripts must be synthetic, especially commands returned by key tools.

The result includes the exact CLI arguments, returned tool lists, native command calls, CLI events and the difference in the session-directory inventory before/after the run. `--ephemeral` must leave no new session files. Check Codex quota outside the runner between batches; stop runs at the maintainer's limit. The runner has no access to the live SSHCode MCP server. Native shell commands run against the fixture under the permission profile; prior conversation turns are rendered as synthetic history in the prompt.

Fixture files are read-only, synthetic absolute paths are translated inside the fixture, and its Git repository has no remotes. CLI logs and SQLite runtime state use a separate disposable directory. Credential and SSHCode connection variables are removed from the child environment. The CLI handles its normal authentication; the runner never reads credentials. Native commands are real, so API shell mocks and simulated web responses do not replace their output on this path.

## Sampling and inspection

- `--surface agent` (default) uses the provider catalog, including orchestration, models, cloud, questions, browser, computer and devices. `--surface all` also tests the broader client API. Conditional features are assumed enabled in these synthetic scenarios.
- With no `--samples`, run two samples and a third when they disagree. Explicit `--samples 1` is for calibration.
- `--baseline <results.jsonl> --stop-on-regression` checks baseline majority passes first and exits nonzero on a majority regression. It stops admitting cases and drains active sample groups so CLI processes are not stranded. Changed outcomes receive a third sample. Also extend the corresponding baseline case to three samples with `--resume --samples 3 --case <ids>`, and review overall per-model pass rates.
- `--case <id,id>` and repeatable `--cases <file.ndjson>` select cases. `--max-steps` bounds API turns.
- `--dry-run` prints actual API request bodies without model calls. `--context` reports character counts and approximate tokens (four characters per token) for the fully expanded definitions. This is not initial model context: native harnesses can defer schemas until discovery. Measure the installed provider's first request before attributing those tokens to every turn. Save captures outside the repository.
- `--template <path>` accepts a sanitized capture; `--model claude-template --dry-run` checks the bundled Claude template without calling Claude.

Examples:

```sh
node evals/mcp-tool-use/run.ts --surface all --dry-run \
  --case answer-completed-child-card,distinct-review-id,action-queue-reorder > "$RESULTS/requests.ndjson"
node evals/mcp-tool-use/run.ts --surface all --context
```

## Cases

Each JSON line follows `McpToolUseCase` in `run.ts`: its source/experience, synthetic world and prior turns, mocked results, prompt, and expected or forbidden calls/text. Use `/home/user` and placeholder ids; commit no personal content, paths or tokens.

Grades match tool arguments partially, including dotted paths through arrays, substrings (`~text`) and numeric bounds (`<=N`, `>=N`). New action tools are graded under their old single-purpose identities so baseline and final expectations stay the same. Keep controls for ordinary work. Add a case before a text change and compare it on the same model; do not relax expectations to hide a regression.

`templates/` holds sanitized upstream harness captures. `trim-capture.ts` can trim a supplied capture without reading harness homes. Inspect any replacement capture before committing it. The real CLI path uses the installed harness instead of these templates.
