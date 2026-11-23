# API keys

When an agent needs a missing or expired platform key, it can call `request_api_key` to show a private entry card on Mac or iPhone. Paste the key there, choose **This chat only** or **All sessions**, and choose when to delete it. The defaults are this chat and 30 days. **Never** and a custom date are also available. Declining lets the agent continue without the key.

Keys are stored in the server host's credential vault (Keychain on macOS), including when you enter one from your iPhone. All sessions means all chats on that server. A chat key does not carry over to a fork or a delegated child thread. Metadata is kept separately from settings and the conversation. Expired keys are checked on access and deleted by a periodic sweep while the server is running; startup also sweeps keys that expired while it was stopped.

Manage saved keys in **Settings → Providers → API keys** on Mac, or **Settings → Provider accounts → API keys** on iPhone. You can change expiry or delete a key. Values are never displayed in Settings.

Agents check `list_api_keys`, then call `prepare_api_key` for a saved key, or pass several names at once to get one command per key. Each call returns a command like:

```sh
sshcode secret run --endpoint 'http://127.0.0.1:PORT/mcp/api-key' --ticket 'ONE_USE_TICKET' --env OPENAI_API_KEY -- curl https://api.example.com
```

Replace the command after `--` with the platform command. Run it on the server host with the matching SSHCode CLI. Tickets last 60 seconds, work once, and authorize only the named key in the requesting thread. Without a ticket from an authenticated SSHCode thread, the CLI refuses access; a supplied thread id is never accepted as proof of identity. Servers listening only on a non-loopback address must enable a loopback or wildcard listener for this command.

The child process receives the key as an environment variable. Exact echoed values on stdout and stderr are redacted before the harness sees them, including values split across pipe chunks. The command itself can access the injected value: transformed output, files it writes, other processes of the same OS user, and network destinations are outside this redactor. Run trusted platform commands and avoid debug modes that log credentials. Deleting or expiring a key prevents future injection; it cannot revoke a credential already passed to a running child or revoke the platform's original key.

## Replace a provider key

When a chat stops because its API key expired or was rejected, choose **Replace API key** on the error card. Enter the new key, then choose **Save and retry** to continue on the same model. The entry shows where to get a key and which other provider instances use it.

Replacing a shared key updates its linked instances. OpenCode keys are saved in OpenCode’s credential store and apply to instances that share that store. The key stays out of the conversation.
