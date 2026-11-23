# Claude

SSHCode uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

## A second subscription for the same chats

Claude Code keeps one full login per config directory, and separate directories keep two
accounts apart, chats included. To spend a second subscription's limits on chats you already
have, give the second account a directory that links to the first one's chats:

1. Add a Claude instance in **Settings > Providers**, set its config directory (for example
   `~/.claude-second`) and turn on **Share chats with the main Claude folder**. The directory is
   made with links to the main folder's chats, settings, skills and plugins. Its login,
   `.claude.json` and account caches stay its own.
2. Sign in once for that directory, with the second account:
   `CLAUDE_CONFIG_DIR=~/.claude-second claude auth login`

Both instances are then fully signed in, each with its own account, usage limits and claude.ai
connectors, and the default instance keeps following this computer's login. A chat can move
between them from its model picker and keep its history; the first turn after a move re-reads
the conversation once.

### With a token only

Without a second directory, an instance can run on a token from `claude setup-token`: leave the
config directory empty, add the token as the environment variable `CLAUDE_CODE_OAUTH_TOKEN`
(marked Sensitive, or bound to a shared key), and turn on **Always use the saved token**.
Running `claude setup-token` can replace this computer's Claude login with the second account;
run `claude auth login` afterwards and sign in to your own account again.

A saved token can only send messages: the instance shows no account email or usage limits and
cannot load claude.ai connectors. Without the switch, a saved token is only a backup for when
the login stops working.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
SSHCode uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. When you return to a large thread
after Claude's prompt cache expires, a **Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Full** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## When a login stops working

A Claude login lasts about four weeks and can also end early. Once Claude can no longer renew
it, the account shows as signed out in provider settings and on **Usage › Limits**, with the
command that signs that config directory in again, such as
`CLAUDE_CONFIG_DIR=~/.claude-second claude auth login`. Until then, new chats, scheduled tasks
and subagents that SSHCode places start on your other Claude accounts, and an agent that asks
for the signed-out account by name gets an error, so it can pick another. Once you sign in, the
account is picked up again by itself at its next status check. If the account has a saved token
as a backup, new work runs on the token instead.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in SSHCode. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in SSHCode. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.

## Keep idle chats warm

With keep-warm enabled, large Claude chats with a one-hour prompt cache stay warm with up to two quiet
pings, 50 minutes apart. This is off by default and uses a little usage while you
are away to reduce the cost of returning to an expired cache. Up to six idle
chats stay warm, prioritizing the largest contexts, including a chat waiting on
your answer to its question. A server restart or update
does not end this: when a chat's next ping is due and its cache is still warm,
its Claude session reopens for the ping, without starting a turn.

Turn on **Keep idle Claude chats warm** in **Settings → General → Updates &
background work**, or **Maintenance → Claude usage** on mobile. Completed pings
appear under **Claude keep-warm** in Usage.
