# SSHCode

SSHCode is a desktop app for coding agents. It runs the agent command-line tools you already pay
for (Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi and any ACP agent) on your
own machine, with your own subscriptions, and lets you drive them from the desktop, a browser or
your phone.

It is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT). See [NOTICE.md](NOTICE.md).

## What it does

- **One window for every agent.** Chat with any installed harness, switch models mid-chat, and
  keep each project's threads, checkpoints and diffs. Every turn ends with a git checkpoint you can
  diff against or restore.
- **Agents that work together.** A lead agent can delegate tasks to other agents and models, run a
  council of models on one question, watch long jobs, and schedule recurring tasks. Workflows let
  you draw a team of agents and run it.
- **Your subscriptions, visible.** See usage limits and resets for each provider account.
  Optionally enable account balancing for new chats.
- **Built-in tools for agents.** A browser preview the agent can drive, terminals, source control
  and pull request review, simulators and devices, and computer use on macOS.
- **Remote ready.** Pair a phone or another computer over your network or Tailscale, or reach a
  machine over SSH. The iPhone and Android app controls everything remotely.
- **Your data stays yours.** Chats, settings and credentials live on your machine
  (`~/.sshcode`). Nothing is sent to a hosted service unless you sign in and enable a hosted connection.

## Install

Download the macOS disk image (Apple silicon) from
[Releases](https://github.com/SSHdotCodes/sshcode/releases/latest), open it and drag SSHCode into
Applications. Or build it from source (below).

The app is ad hoc signed and not notarized, so macOS blocks the first launch: open it once, then
choose **Open Anyway** in System Settings → Privacy & Security (or run
`xattr -dr com.apple.quarantine /Applications/SSHCode.app`).

## Set up your agents

SSHCode runs the agent tools installed on the machine. Install at least one and sign in; the new
chat screen shows which ones SSHCode sees, and Settings → Providers sets each one up.

| Agent           | Install                                                           | Sign in                   |
| --------------- | ----------------------------------------------------------------- | ------------------------- |
| Claude Code     | `curl -fsSL https://claude.ai/install.sh \| bash`                 | `claude auth login`       |
| Codex           | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`           | `codex login`             |
| Antigravity CLI | Settings → Providers → Antigravity                                | Sign in with Google there |
| Grok Build      | `curl -fsSL https://x.ai/cli/install.sh \| bash`                  | `grok login`              |
| Cursor CLI      | `curl https://cursor.com/install -fsS \| bash`                    | `agent login`             |
| OpenCode        | `curl -fsSL https://opencode.ai/install \| bash`                  | `opencode auth login`     |
| Pi              | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` | `/login` inside `pi`      |

Features that run without you choosing a model (chat titles, commit messages, the workflow
compiler, Overview) pick from the agents you have.

## Build from source

You need macOS on Apple Silicon for the desktop app, Node.js 24, pnpm (through Corepack),
[Vite+](https://viteplus.dev/guide/) (`curl -fsSL https://vite.plus | bash`), a Rust toolchain
(`rustup`) and the Xcode command-line tools.

```bash
git clone https://github.com/SSHdotCodes/sshcode sshcode && cd sshcode
vp i                         # install dependencies
vp run dev                   # server and web app, for development; open the printed pairing URL
vp run dev:desktop           # the Electron app, for development
```

### Desktop app

```bash
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --build-version 0.1.0 --output-dir release
```

The disk image lands in `release/`. Drag SSHCode to Applications. Data lives in `~/.sshcode` and
`~/Library/Application Support/sshcode-shared`.

To run only the server (for a headless machine you reach from the phone or a browser):

```bash
vp run build:desktop
node apps/server/dist/bin.mjs
```

### iPhone and Android

The phone app is in [`apps/mobile`](apps/mobile/README.md). Its README covers building with a free
Apple ID (Xcode Personal Team) or a paid developer account, choosing your own bundle id, and
pairing the phone with your computer.

## T3 Connect (optional)

T3 Connect is T3's hosted sign-in and relay service. Public SSHCode builds include it; your
machine does not become reachable until you sign in and enable the connection. Sign in with
**email** (a code or password). Social sign-in returns to the official app's `t3code://`
callback, which SSHCode does not register. You can also pair directly without an account.

To self-host, deploy [infra/relay](infra/relay) and set all four `T3CODE_CLERK_*` and
`T3CODE_RELAY_URL` identifiers in the build environment for your Clerk instance and relay.
To build without Connect, remove the four assignments from [`.env.example`](.env.example)
and leave them unset in the build environment. See [SECURITY.md](SECURITY.md).

## Documentation

- [User guides](docs/user) for each feature
- [Architecture](docs/internals/overview.md) and [development runbook](docs/operations/development.md)
- [Contributing](CONTRIBUTING.md) and [security policy](SECURITY.md)

## License

MIT, inherited from T3 Code; see [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) and
[THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md) for artwork and brand marks with other terms.
