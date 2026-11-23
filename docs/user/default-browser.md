# Use SSHCode as your default browser

On macOS, the desktop app can be your default web browser. Links you open from other apps then
open in SSHCode. When the thread on screen shows its browser panel, the link opens there as a new
tab. Otherwise it starts a new thread without a project, with the browser panel maximized on the
page, so you can ask an agent about it right away.

Choose **SSHCode** under **System Settings → Desktop & Dock → Default web browser**. To go back,
choose another browser there.

HTML files you open from Finder open the same way. [Prompt links](prompt-links.md) to
app.t3.codes open in the app as a draft.

A link that launches SSHCode waits until the app has connected to its environment, then opens.

## Browse with an agent

Ask an agent to open a website or test your app. Its browser tabs appear in the chat's Browser
panel, where you can watch, switch tabs, and take control. An agent can read a tab you control,
but needs its own tab or your released control before interacting with it. Browser profiles let
you choose which saved logins a new tab uses.

Agents inspect pages as compact text by default and request images when they need visual detail.
Ask for a screenshot when you want a saved image to keep or share. Browser access can be changed
alongside other built-in tools in **Settings → Tools**, for every provider or an individual provider.
Existing project browser-access restrictions still apply.
