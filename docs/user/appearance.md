# Appearance and themes

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, select
the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Screen recording privacy

Turn on **Screen recording privacy** in **Settings → Appearance** before recording or sharing
SSHCode. It is off by default and saved on this device. Navigation uses aliases for chat titles,
custom tabs, projects, and computers, and hides workspace paths and chat hover previews.
Turn it off to show the original names again. This changes the display only; messages, file
contents, browser previews, and terminal output remain visible.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Settings → Chats → Composer context** to keep those controls visible after the thread
starts. This preference applies to the web and desktop clients.

## New chat dashboard

An empty new chat shows your recent activity, provider usage, and this month's totals over a horizon
backdrop. Usage shows the limit closest to running out and hides when the harness reports none;
this month compares the days so far with the same days of last month. Turn off **New chat dashboard** in **Settings → Appearance** for the plain new-chat
screen. Turn on **Chat backdrop** to keep the horizon, dimmed and tinted for the selected harness,
behind conversations too. Both choices are saved separately on each device.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Harness themes

On web and desktop, a chat can take on the look of the app behind its harness: Codex chats look like
the Codex app, Claude chats like the Claude app, and Grok chats like the Grok app. Muse, Mistral Vibe,
and Qwen Code chats also have their own looks. Mistral Vibe and Qwen Code appear in the harness theme
settings when their agents are installed and enabled. The look applies while that chat, or a new
chat with that harness selected, is open; elsewhere your own theme stays. Light and dark follow your appearance mode, except Grok, which
is always dark.

Under **Harness themes** in **Settings → Appearance**, choose Default, a built-in harness look, or
any of your themes for each harness, or turn harness themes off. **Turn off harness themes** in the
command palette does the same. Like other appearance preferences, these are saved per device.

On iPhone, **Settings → Appearance → Harness themes** offers the same built-in harness looks and
the mobile theme collection. The look covers the thread, new-chat draft, and side-chat sheets;
home, settings, and the workspace status capsule keep your app theme. Use Reset to restore the
default harness assignments.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a SSHCode or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. With the desktop app's local environment off, they come from the
[background service](./background-service.md) on the same machine while the app is connected to
it. app.t3.codes and other connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, SSHCode falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
sshcode theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `sshcode theme set`. Run the command again to
reapply it, even if the name is unchanged.

`sshcode theme clear` removes the default without changing anyone's current theme. `sshcode theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from SSHCode into `~/.sshcode/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `sshcode theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. SSHCode
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.

## Discord mode

Turn on **Discord mode** in **Settings → Appearance** on each device. Agent replies use mascot
profile pictures. Choose your own **Profile picture** there too; pictures stay on the device
where you choose them.

On web and desktop, your chat tabs become servers. Use **+** in the server rail to create one,
or move a chat with **Move to server** in its menu. **Home** shows all chats. Right-click a
server and open **Server settings** to rename it or choose an emoji or image. Deleting a
server keeps its chats in Home. The same groups appear as tabs in the main layout.

**Discord mode** and **Casual voice** are experimental previews in **Settings → Appearance**.
Both stay off until you turn them on. Casual voice rewrites replies in either layout, including
steer replies. With it off, Discord mode still shows the original messages.

When Casual voice is on, open **casual voice** in a chat and choose a mode.

**Local** keeps every rewrite on this computer. Set an OpenAI-compatible endpoint URL
(including its API base path) and model id.

**Local + cloud for steers** sends normal replies to that local endpoint. Steer replies use a
cloud model from your connected providers, and those calls leave out your style examples.

**Cloud only** sends every rewrite to that cloud model, including your style examples.

Casual voice starts on for each chat once a model is chosen. You can turn it off for an
individual chat. Choosing the model, the mode, or the training log needs settings access to
that server. The cloud model uses medium effort when that model offers it. A control beside
the model can pick another effort.

Replies can use short, lowercase wording without emojis, based on a small sample of messages
you wrote. Only the selected model receives those examples. Code, commands, links and other
technical text stay exact. Streaming stays normal. Tools and questions stay original.
If a rewrite cannot be checked or takes too long, the original stays visible.

On web and desktop, steering a running agent can bring a relevant thought into the chat as a
reply. Casual voice stays quiet when there is no answer to send. Your selected model receives
those thoughts and a short excerpt of your steer. If rewriting is unavailable, only the first
thought appears unchanged.

The wrapper can turn narration into a short work status or hide obvious filler. A **hid 1 line**
chip opens the hidden original. Replies can arrive as several short messages, with a brief typing
indicator between them. History and reduced motion show the whole reply right away. **show
original** collapses a burst back to the exact reply; **copy original** copies it. Agent history,
follow-ups, forks, side chats, handoffs, summaries and generated titles always use original text.

Under **casual voice → local style file**, you can choose a `STYLE.md` on the server. SSHCode reads
its rules and a small, filtered sample from `messages.jsonl` beside it. With no file, it uses short
messages from the chat. You can also place the files in `userdata/casual-voice-style/` under your
SSHCode data folder. Local rewrites and cloud-only rewrites can send that sample to the model you
chose. Steer calls in **Local + cloud for steers** do not.

**save cloud rewrites for training** keeps a private log on this server of the masked text the
cloud model saw, what it wrote, and whether the rewrite was kept. The log lives in your SSHCode
data folder. It is not uploaded, and guest sharing cannot read it. Turn the switch off to stop
saving new rows. Choosing **show original** on a cloud rewrite is saved as a note that you
preferred the original, without storing the message again.

The voice choice and chat switches follow the server, so the phone uses the same ones.
