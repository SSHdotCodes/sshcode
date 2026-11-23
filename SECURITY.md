# Security

## Reporting a vulnerability

Please report security problems privately through the repository's **Security → Report a
vulnerability** page (GitHub private vulnerability reporting), not in a public issue or
discussion. Include the version or commit, the steps to reproduce, and what an attacker gains.
You should get a first response within a week. Please give us a reasonable time to fix the
problem before you disclose it.

## What SSHCode exposes

SSHCode runs a local server that can start coding agents, read and write files in your projects,
run commands and drive a browser or the desktop on your machine. Anyone who can reach that server
with a valid credential has that power, so treat every way in as a key to the machine.

- **Local.** By default the server listens on this computer only, and the desktop app talks to it
  directly.
- **Network and Tailscale.** When you allow other devices (Settings → Connections), the server
  listens on your network. Devices pair with a one-time link or QR code that grants a long-lived
  credential; review and revoke paired devices in Settings → Connections. Prefer Tailscale or a
  trusted network to an open one.
- **Outside agents.** Agents in other apps connect through the server's MCP endpoint with OAuth;
  each grant is listed and revocable in Settings → Connections.
- **T3 Connect relay.** A build with T3 Connect configured signs in through Clerk and **exposes
  the local server through a relay on the internet**: the relay forwards requests from your other
  signed-in devices to this computer, so it can be reached from anywhere, not just your network.
  Requests are authenticated (Clerk session, DPoP-bound relay tokens and the server's own
  credentials), but the relay operator and the Clerk instance are part of your trust boundary, and
  a stolen or phished sign-in can reach the machine. Public builds include T3's hosted service. You choose whether to
  sign in and enable remote access; turn it off in Settings → Connections when not needed.

## Hardening tips

- Keep pairing links and QR codes private; they are credentials until used or expired.
- Revoke devices and outside-agent grants you no longer use.
- Run agents in permission modes that ask before commands when you work in untrusted repositories.
- Keep the agent CLIs and SSHCode updated.
