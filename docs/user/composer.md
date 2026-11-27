# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

## Compare models

On Mac or web, start a new chat, open the composer’s **+** menu and choose **Compare models**.
Choose two to four models, then send your prompt. Each chat receives the same
attachments and context. Git folders give each chat a separate worktree. With
**No project**, each chat gets its own scratch folder. Existing non-Git projects
share their folder.

To return to a single model before sending, choose **Stop comparing** from the **+** menu.

The sidebar keeps the comparison in one row. Read the chats side by side and use
the shared composer to follow up with all of them. Answer approvals and questions
in the chat that asks. On iPhone, open the comparison and choose a member to read
or reply to it.

Choose **Continue with this** to keep working in one chat. The others stop and
move to **Settled**, where you can reopen them. Their history stays saved.

## Control a running Claude Code CLI session

Choose **Terminal**, the last chat tab on Mac and iPhone. It lists open Claude Code
CLI sessions with Remote Control enabled, marked **Terminal session**. They stay
separate from **All**. Open a session to read its output, send messages, stop a turn,
or answer a simple tool approval received while connected. Prompts that need extra
interaction, and approvals already waiting when you connect, can be answered in the CLI.

Terminal talks to one machine at a time. When every machine is selected, that
machine is your primary host. An older SSHCode asks you to update it and is
not contacted. Search filters the sessions on this device. A message that
fails to send stays in the composer.

The original CLI keeps running with its own tools and settings. Leave the computer
awake and the CLI open. Enable Remote Control in Claude Code with `/rc` if needed;
sessions that already enable it automatically need no extra setup. On Mac, allow
SSHCode to use the Claude Code login if macOS asks.

## Move an SSHCode chat to Terminal

On a local Mac, choose **Open in Terminal** from the chat menu or command palette
to continue a chat in its native CLI. SSHCode stops its run before opening Terminal
in the chat's folder, including its worktree. This works with your own Codex or
Claude Code installation and an existing native session. Managed and remote
runtimes aren't supported.

When you're done, quit the CLI in Terminal and choose **Bring back** in SSHCode.
The next turn resumes that session with its Terminal context. A timeline divider
marks the time away; Terminal messages aren't copied into the chat. Sending stays
locked on every device until you bring the chat back. Restarting the server clears
that lock, so quit the CLI before sending after a restart.

## Wait for background work

Ask an agent to monitor a build log, wait for a service to become ready, or watch
status changes. It can start a background monitor and end its turn, then resume
when the command prints a line or exits. A monitor also resumes the agent once
when its job keeps repeating the same error, or runs well past the time the agent
expected. Use a full-access thread in Default
mode for app-owned shell monitors. Claude Code can use its native Monitor tool.

App-owned monitors time out after one hour by default. An agent can choose up to
24 hours, or make a monitor persistent until stopped. Stop the thread, archive
or delete it, or restart the server to end its monitors. Monitors do not survive
a server restart.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. On a
hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere
to keep a large paste editable in the composer instead.

## Formatting

The composer writes Markdown and shows it styled as you type. Markers such as
`**` stay in the text and show beside the styled words when your cursor is on
them. Lines starting with `- `, `1. `, `- [ ] `, `> `, `# ` or `---` become lists,
task lists, quotes, headings and rules; ` ``` ` followed by Enter opens a code
block. What you typed is what the agent receives, markers and numbering
included, and `#1234` without a space still looks up a pull request.

Enter sends. In a list or quote, **Shift+Enter** continues it, and Shift+Enter
on an empty line leaves it; **Tab** nests a list item. In a code block, Enter
starts a new line at the current indentation, **Tab** and **Shift+Tab** indent
the selected lines, and a closing ` ``` ` followed by Enter, or two blank lines
at the end, leave the block. **Backspace** at the start of a code block turns it
back into plain lines. Choose the language in a code block's corner to change
it. Very large code blocks are shown without syntax highlighting.

## Emoji

On web and desktop, type `:ta` to find `:tada:` and other emoji. Use the arrow
keys to choose a suggestion, then press Enter or Tab to insert it. Escape closes
the suggestions. You can also open **Choose emoji** to search by name or keyword;
your recent choices stay on this device.

Shortcodes such as `:tada:` display as emoji in messages on web, desktop and
mobile. Inline code and code blocks keep their literal text. Messages containing
only one to three emoji appear larger.

## Attach files

Attach up to 100 files per message. Each image can be up to 10 MiB, with at most
80 MiB of images in one message. Other files, including videos, can be up to
50 MiB each, subject to the environment's upload support and limit. The agent
receives them on the environment's machine. Provider and model limits still
apply, including images already in the conversation. In Antigravity, Gemini can
open attached videos and hear their sound. It can also listen to WAV, M4A,
MP3, Ogg, and Opus recordings. For AAC and FLAC up to 20 MiB, SSHCode uses
FFmpeg when installed on the environment machine to repackage the audio
without re-encoding it.

You can ask an agent to send workspace files to another chat or a subagent in
the same environment, up to 50 MiB total per handoff.

Uploads begin when you add an attachment. On web and desktop, you can send while
uploads finish; the message appears as sending until its attachments are ready.
If an upload fails, recover the message and retry or remove the failed attachment.
Question answers and messages redirecting a pending approval wait for uploads
before sending. On web and desktop, reloading before an upload finishes requires
you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the mobile photo
library; photos over the image limit are also resized to fit. On mobile, you can
also send files to SSHCode through another app's system share sheet.

On iPhone and iPad, videos that exceed the upload limit are compressed on the
device with their audio. If a video still cannot fit, trim it to the suggested
duration and attach it again.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, choose **Settings → Chats → Follow-up behavior** to queue
new messages for a later turn or steer the running turn immediately. The setting
applies to this client; already queued messages keep their place. Queued messages
are saved on the server and can be edited, reordered, or removed above the composer.
`Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses the opposite action:
it steers when your default is Queue and queues when your default is Steer.

Some Antigravity turns support steering by interrupting and sending your follow-up.
On Antigravity 1.5 and later, if a background update is already streaming, the
agent finishes that update before replying to your steer. When an active turn
cannot accept steering, the message queues. Choose **Send now** on its queued
row to stop the current reply and send that message next.

When the agent has finished replying and is only waiting on a timer or background
work, your message reaches it at once and shows as a normal message, not a steer.
The working timer starts again from it.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message as a steer. This leaves the current draft intact and
requires an active turn that supports steering. Change
`thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the
start of the composer to edit the most recently queued message. Change
`thread.editQueuedMessage` to use another shortcut.

Mobile has the same choice under **Settings → Chats → Follow-ups**. While a turn is
running the send button shows which action it will take. Long-press it to use the
other action for a single message, or hold `Cmd` while sending from a hardware
keyboard. The button only offers Steer when the running agent supports it.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

If a chat is deleted before its queued message is sent, **Unsent message** appears
in the chat list. Open it to restore the message and its attachments into a new
or existing chat in the same environment, or discard it.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

To rename a built-in model on every client, edit the server's `settings.json` in its `userdata`
directory. Add a custom model entry with the built-in model ID and a new name under that provider
instance:

```json
{
  "providerInstances": {
    "codex": {
      "driver": "codex",
      "config": { "customModels": [{ "slug": "gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Choose a model

The model picker lists models by who made them: OpenAI, Anthropic, Qwen, Z.ai,
DeepSeek and so on. A model that several harnesses or gateways can run, such as
GLM-5.3 Flash through Pi, Hermes or Kimi Code, is one entry. **Runs in**, beside
the list, shows where the selected model runs; pick another to switch, and the
reasoning levels follow it. A model starts on the harness you last used for it on
this device, else on the harness that runs that family best. Search and Favorites list every harness separately. On the phone,
**Runs in** is in the Options card.

If a run fails because the provider says the model is deprecated, retired or does
not exist, SSHCode files that model with the older models on that provider for a
week, or until a run on it succeeds. Agents stop delegating to it too.

## Model defaults

SSHCode remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection. On the phone, a machine with no default model
of its own starts new chats on the default of the machine where you start most of your
chats, when it offers that model.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

On iPhone, long-press an assistant response, adjust the selection, and choose
**Cite** to put the quote at the composer cursor. If the passage appears more than once
and the app can't tell which one you selected, it asks. Tap the quote's chip to add a
comment, remove it, or choose **Show in chat** to jump to the source. Sent quotes appear
as cards in your message; tap one to read it in full. Choose **Side chat** instead of
**Cite** to ask a side question about the selection without changing your draft.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to restore them as well.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, a folder
inside it, or a folder that contains it, since
restoring would erase their changes. Completed subagents belonging to the reverting
thread do not block restoring that same worktree, provided they have no queued or
active work, pending requests, or background tasks. A thread that works in the project
directory rewinds the conversation only. In a folder that is not a Git repository there is
nothing to restore, so the edit always leaves files as they are. The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

If you stop a run and it changed no files, editing that latest message skips the
confirmation. On mobile, the same action is **Edit and resend** in a message's
menu, and a pencil appears under your latest message after you stop its run.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.
Some agents can only rewind by starting a new session, which forgets the whole
earlier conversation; their confirmation says so and is never skipped.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft. While recording, the screen stays
awake; it can sleep normally once recording stops.

Voice input records from the first connected microphone in **Settings → Microphone**.
The list mixes kinds (built-in, other wired, other Bluetooth, CarPlay) with wired and
Bluetooth devices you have dictated with, listed by name. Drag to rank them together:
for example, put **Other Bluetooth** above your AirPods so a new headset is preferred
while the AirPods microphone stays low. By default, CarPlay comes after the built-in
microphone.

Transcription runs on your device. SSHCode deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Queued messages

On web and desktop, the composer shows **Interrupt** while the agent is working and the draft is
empty. Adding text or attachments replaces it with a steer arrow. Click it to send a message into
the active turn, or press `Enter` on desktop. Hold `Cmd` on macOS or `Ctrl` on Windows and Linux to
switch the button to a queue icon. Click while holding that key, or press `Cmd+Enter` or
`Ctrl+Enter` on desktop, to queue the message for after the active turn.

Queued messages appear above the composer. Rows show a thumbnail of any attached image alongside
the text. Drag a row by its handle to reorder it, use the handle's arrow keys, promote the message
to a steer, or remove it.

**Stop reply** lets the next queued message start when the reply ends. **Stop**
and **Stop everything** hold queued messages, as can a server restart. Choose
**Send queued messages** in the queue to send them in order. You can edit,
reorder, or remove held messages without starting them.

The pencil on a queued row opens that message in the composer for editing. The original message
stays in the queue until you save, and its row is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** on its row leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → Chats →
Show skills in slash menu**. Only skills enabled for the provider are listed.

After you add or change commands, skills, plugins, or MCP servers, use **Restart
agent session** in the command palette on web and desktop. The conversation
continues, and your next message starts the agent again with the new setup.

Provider commands must start the message to run. SSHCode commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Type `@` followed by part of a model or provider name, such as `@opus` or `@gpt`,
to name that model for the agent. Picking it inserts `model:<instance>/<model>`
and shows a chip with its details. This does not change the thread's model.
Join search words with `:`, `/`, or `-`, for example `@gpt:codex`.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Goals

With Codex and Claude, send `/goal` followed by what "done" means, for example
`/goal all tests in packages/api pass`. The agent keeps working across turns
until it judges the goal met. The thread shows **Goal** while it works, and a
row above the composer shows the goal and its progress.

- `/goal` alone shows the current goal. `/goal clear` removes it.
- Codex also supports `/goal pause` and `/goal resume`. Stopping a Codex goal
  pauses it.
- Stopping Claude ends the current turn, but the goal stays set. Claude checks it
  again at the end of your next message.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Pull requests linked to the thread are included
from any repository and listed first, after any exact number match. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Another thread can be context too. Type `@` followed by part of its title to pick one from
the same server, or on web and desktop drag a thread out of the sidebar and drop it on the
composer; a multi-selection drops together. The chip shows the thread's current title and
opens it when selected. Your prompt only carries a reference: the agent reads the thread's
history on demand, so attaching a long thread costs nothing until the agent looks. Attaching a
thread does not change it, and the agent cannot send messages to it unless you ask.

Dropping a thread from another environment attaches a saved transcript file. The source
environment must be connected and up to date. The transcript includes the visible history and
saved text context at the time of the drop; later messages and the contents of attached files
are not copied. The agent can read the saved transcript after the source disconnects. Normal
file attachment limits apply.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete SSHCode tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere.

## Images and videos in messages

Choose **Media** in the chat header to browse its pictures and videos together. Scroll
up for earlier media, open an item to move through the collection, or choose **Show in
chat** to return to its source. On Mac, drag a thumbnail to another app or press Space
on a focused thumbnail for Quick Look. On iPhone, the viewer can save pictures to Photos
or share them.

To circle or point out something in a picture, open its preview and choose **Markup**
(the pen button on web and desktop). Drag to draw a circle, rectangle, arrow, or pen
stroke. If a pen stroke snaps to a shape, choose **Keep freehand** or **Undo** to
restore your stroke. Choose **Text** and click or tap the picture to add a label.
Press Enter or click or tap away to apply it. Drag a label to move it, or double-click
or double-tap it to edit. Select a label and press Delete or Backspace to remove it.
On iPhone, select the label and choose **Delete**. Choose **Done** when you're
finished. **Add to chat** attaches the marked picture to your current draft so
the agent can see it. You can also save it or copy it on web.
Marking a picture already in your draft replaces that attachment when you choose
**Done**. **Cancel** leaves the original alone. On iPhone, swiping and zooming pause
while you draw.

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your SSHCode session. Workspace HTML
starts with scripts off. Choose **Run** to enable them for that file, or **Turn
scripts off** to disable them again. The choice stays on this device. Scripts can
read neighboring workspace files and connect to the internet, so only run pages
you trust.

The file viewer recognizes images, HTML, and PDF files by their filename extension,
including filenames or folders containing `#` or `?`.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.

## Debug runtime bugs

Start a message with `/debug` and describe the bug. Your message shows a compact
**Debug** chip; the workflow instructions go only to the agent. This works with any provider
on web, desktop, and mobile. The agent forms hypotheses, adds temporary logging,
and asks you to reproduce the bug. Pick **Done** after reproducing it so the agent
can read the capture, fix the cause, verify, and remove the logging.

Code on the same machine sends its logs locally. For a bug on another device, the
agent also gets an address that device can reach through T3 Connect, Tailscale, or
your local network. If an older relay-only link offers none, relink it once so the
server learns its public address. Captures expire after
two idle hours and are deleted when the agent stops them or the server restarts.
