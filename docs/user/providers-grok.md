# Grok

SSHCode uses Grok Build's login and configuration on the environment's machine.
See [provider setup](./install.md#providers) for installation and shared provider settings.
An empty **GROK_HOME path** uses the instance's `GROK_HOME` environment variable,
or `~/.grok` when unset. A configured path takes precedence.

## A second subscription for the same chats

Grok keeps one login per home directory. To use a second account's limits on
chats you already have:

1. Add a Grok instance in **Settings > Providers**, set **GROK_HOME path** (for
   example `~/.grok-second`) and turn on **Share chats with the main Grok folder**.
   The directory is made with links to the main folder's chats, settings, skills,
   plugins and CLI install. Existing files stay as they are. Its login and account
   caches stay its own. Hooks, built-in bundles and memory also stay separate:
   Grok's sandbox or memory store requires these to be real files and directories.
2. Sign in once for that directory, with the second account:
   `GROK_HOME=~/.grok-second grok login`

Both instances then have their own account and usage limits. A chat can move
between them from its model picker and resume the same Grok session. Shared chat
history is counted once in Usage. When connecting remotely, sign in on the machine
running the environment.
