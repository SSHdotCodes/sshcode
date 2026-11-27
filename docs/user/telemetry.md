# Product usage data

The server sends no product usage data. It records product events only when its environment sets
`T3CODE_TELEMETRY_ENABLED=true` and names your own PostHog project with `T3CODE_POSTHOG_KEY` and
`T3CODE_POSTHOG_HOST`. `DO_NOT_TRACK=1` turns them off even then. Events carry a hashed random
identifier for the installation, never one from your provider accounts. They include the provider,
model (custom models as `custom:<provider>`), reasoning effort, permission mode, turn result,
duration, and main-agent token totals when available.

Events never include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` and `DO_NOT_TRACK` from your shell profile (for
example `~/.zshrc`) on macOS and Linux, so export them there and restart the app. On Windows, set
them as user environment variables.

## T3 Connect tracing

T3 Connect traces leave the machine only when the build or the environment names a trace endpoint
(`T3CODE_RELAY_CLIENT_OTLP_TRACES_*`); none is built in. They carry span names, timings, and error
types, never error messages, stack frames, machine addresses, or log text. `DO_NOT_TRACK=1` turns
them off.

## Website icons

Website icons are off by default: links and agent web activity show the site's first letter, with
no request. Turn on **Settings > Appearance > Website icons** to show each site's icon. Links then
load it through Google's icon service, which sees each site name, and agent web activity asks the
site itself. On the phone the switch is in the same place and covers agent web activity.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
