# Outside agents

Agents that SSHCode did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Set up an app

Press **⌘K**, search for **MCP**, and choose **Use SSHCode in another app (MCP)**.
Or open **Settings → Connections → Outside agents → Connect an app**.

1. Choose the app. Under **Something else…**, choose **Claude Code**, **Codex**,
   or **Another MCP app**.
2. Choose its access. **Supervised** is the default. If needed, turn on
   **T3 Connect** and **outside agents** in the wizard; it continues on its own.
3. Open the app's connection page and use the copied URL, or paste the full
   command in your terminal. Keep the wizard open while the app signs in.
4. Type the 4-digit code from the sign-in page in your browser into SSHCode.
   The wizard then shows that sign-in's chosen name, where its access goes, and
   the access you selected. Choose **Allow** or **Deny**.

The wizard shows **Connected** once the app finishes signing in, then **Done** closes it.
You do not need a pairing code. If you close the wizard, the existing approval
prompt still appears in SSHCode on your Mac or iPhone.

SSHCode only copies a terminal command; you run it yourself. It does not change
Claude Code's, Codex's, or another app's configuration files.

- **Read only** allows reading projects, threads, providers and models.
- **Supervised** through **Full access** also allow starting, messaging and
  stopping threads. Those threads cannot run above the mode you choose.

Cloud apps need a reachable T3 Connect address. Builds without T3 Connect still
support local MCP clients. Turning on T3 Connect from the wizard requires a
direct connection to the host and permission to manage its relay settings.
The owner's T3 Connect account sign-in is still required if not already signed
in; the wizard resumes afterward.

SSHCode takes new sign-ins for 10 minutes. Choose **Retry sign-in** in the
wizard if that window expires, then retry from the other app. Already approved
apps keep working. **Stop** in the Outside agents section stops new sign-ins.

## Get the MCP URL

The Connect step copies a T3 Connect URL for a hosted app or a full command
using the current connection for a local CLI. A saved environment's menu in
**Settings → Connections** also has **Copy MCP URL**. That menu prefers its
T3 Connect address when available, then uses a reachable local route:

```text
https://<environment-address>/mcp
```

A hosted app must use the T3 Connect address. A LAN or Tailscale address works
only where that network is reachable, and `localhost` works only on the host.
See [remote access](./remote-access.md).

## Approve a sign-in

Outside agents are off by default. Turning them on lets new apps ask for
approval during a 10-minute sign-in window. Later, start another window with
**Connect an app** in **Settings → Connections → Outside agents**.

The sign-in page names the app and where its access goes. For a terminal app,
approval returns to a `localhost` address on the computer that opened the page.
For a hosted app it goes to that service, such as `chatgpt.com`. Only approve a
sign-in you just started. The name is chosen by the app.

The page shows a 4-digit code and waits while you answer in SSHCode on your Mac
or iPhone, including when the browser is already signed in. Type that code in
SSHCode to find your sign-in, review its destination and access, then choose
**Allow**. Until the code matches, SSHCode only shows that sign-ins are waiting.
Use the code on the page you opened, never a code supplied in an app's name. The existing **Use a pairing
code instead** option remains available for manual setup. Create a code in
**Settings → Connections** or with `sshcode auth pairing create` on the host.

## Claude Code

```sh
claude mcp add --transport http sshcode https://<environment-address>/mcp && claude mcp login sshcode
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `sshcode` as connected
once you approve.

## Codex

```sh
codex mcp add sshcode --url https://<environment-address>/mcp
```

`codex mcp add` opens OAuth sign-in when it discovers the server. To retry later,
use `codex mcp login sshcode`. Add `--no-browser` to that login command to print
the sign-in URL instead of opening it.
`codex mcp list` shows `sshcode` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Remove an agent

Approved agents appear under **Settings → Connections → Outside agents**.
Choose **Disconnect** to cut off an app’s access immediately. Turning outside
agents off also stops their access until you turn it back on. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
