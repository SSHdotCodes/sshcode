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

This runs the installed `codex exec --ephemeral` with a fresh Git fixture per sample and a loopback-only mock MCP server. It ignores user config, rules and plugins. The mock serves the branch's model-facing names, descriptions and input schemas. It records calls and returns synthetic results, including for `delegate_task`. Native subagent spawning is disabled.

The workspace-write permission profile allows changes to the fixture and reads of minimal system runtime paths. Shell networking is disabled. The macOS profile explicitly denies the system scratch directories, with the fixture as the writable workspace. Scratch space for shell commands lives inside the fixture. Fixture scripts must be synthetic, especially commands returned by key tools.

The result includes CLI arguments, returned tool lists, native command calls and CLI events. Prior conversation turns are rendered as synthetic history in the prompt.

Set `CODEX_HOME` to a separate CLI profile already signed in to ChatGPT. The CLI checks the login before the run and uses the subscription account. For allowance-only runs, confirm available quota and that the account has no flexible usage credits before starting. The runner passes the CLI a minimal environment and leaves authentication to Codex.

Synthetic absolute paths resolve inside the fixture. Its Git repository has no remotes. Logs and SQLite state live in a sibling directory. Both directories are removed at the end of the sample. The CLI executes native commands directly.

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
