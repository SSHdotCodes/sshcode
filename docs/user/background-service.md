# Running SSHCode in the background

On Linux and macOS, SSHCode can run as a service for your user so you do not need
to keep a terminal open.

Not available yet: SSHCode's releases don't include the server download this needs, so run the server from a source checkout instead.

## Manage the service

Install the `sshcode` CLI first ([Install SSHCode](./install.md#the-sshcode-command)), then
run these commands on the machine that will host SSHCode:

| Task                            | Command                     |
| ------------------------------- | --------------------------- |
| Install and start               | `sshcode service install`   |
| Inspect status and log location | `sshcode service status`    |
| Move to a newer release         | `sshcode update`            |
| Restart                         | `sshcode service restart`   |
| Stop and remove from startup    | `sshcode service uninstall` |

To connect a device to the background service, run `sshcode pair` on the host.

Uninstalling the service leaves your projects, threads, and settings intact.
Running `sshcode service install` again repairs a service that `sshcode service status`
reports as broken.

`sshcode update` downloads the newest release on your channel and switches `sshcode`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `sshcode service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating SSHCode](./updating.md).

Pass an exact version (`sshcode update 0.0.42`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `sshcode update` ask for confirmation before
installing one.

`sshcode uninstall` removes the background service, the `sshcode` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.sshcode/userdata` are kept. Pass `--yes` from a
script.

## Platform support

Linux needs systemd user services. Setup enables lingering so SSHCode starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. While an agent's turn runs,
the server keeps the computer from idle-sleeping; turn that off under
**Settings → General → Keep the server awake while agents work**. A closed laptop
lid still sleeps it. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

T3 Connect can offer service installation during setup, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Troubleshooting

Start with `sshcode service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running SSHCode as root creates a separate installation and Connect
identity. Without administrator access, run `sshcode serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status t3code.service`, then use the repair command printed by SSHCode.                     |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `sshcode service restart`.                       |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `sshcode` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For failures after signing in to T3 Connect, see
[connection troubleshooting](./remote-access.md#t3-connect-troubleshooting).
