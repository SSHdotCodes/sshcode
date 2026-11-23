# SSHCode for Quest: bridge contract v1

Both sides implement this contract:

- the Quest app (`apps/quest`, Kotlin + Meta Spatial SDK);
- panel mode in the web UI (`apps/web`).

Keep both sides and their tests in sync when changing the contract.

## Shape

- The Quest app is a mixed-reality (passthrough) Spatial SDK app for Quest 3. It hosts the real SSHCode web UI in floating panels: Android View panels containing a `WebView`.
- The web UI is served by the user's SSHCode server, e.g. `http://<mac>:3773`. During development it can be reached through `adb reverse tcp:<port> tcp:<port>`, so the headset uses `http://localhost:<port>`.
- Package id: `com.example.sshcode.quest`.

## URLs and panel roles

Every panel loads an ordinary web route with the query parameter `sshcodePanel=<role>`:

| role       | route                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| `overview` | `/overview?sshcodePanel=overview` (closed by default; opens in a side window)   |
| `thread`   | `/<environmentId>/<encodeURIComponent(threadId)>?sshcodePanel=thread`           |
| `new`      | `/new?sshcodePanel=new` (the central home; branches to a side window once sent) |

The web stores the role in `sessionStorage` on first load, so in-app navigation keeps panel mode for that WebView.

The Quest designates the snapshot source independently of the role with `sshcodeFeed=1`.
The flag is saved as `sshcodeFeed` in `sessionStorage` and survives navigation. An explicit
`sshcodeFeed=0` revokes it. The central home loads `/new?sshcodePanel=new&sshcodeFeed=1`.
When it becomes a chat, Quest keeps that WebView, moves it to a side slot, changes its
stored role to `thread` and feed to `0`, removes the initial query parameters, and
signals `window.dispatchEvent(new Event("sshcode-quest-feed"))`. This cancels the old
snapshot timers. A fresh home takes its centre pose and becomes the feed source.

## Panel mode (web side)

- Hide the app sidebar, desktop workspace/project details card and any chrome the Quest window replaces. Keep each route's own content: chat feed, composer, Overview. The plain `new` role uses the same new-thread landing and mascot hero as the desktop app.
- Make it readable at VR distance:
  - base text about 1.2–1.25× the desktop size;
  - hit targets at least 40 px;
  - no hover-only controls. Pointer hover still exists from controllers and hands, but must not be required.
- In panel mode with the bridge present, opening another chat calls `SSHCodeQuest.openThread(...)` instead of navigating. That covers an Overview item, a thread link or chat chip, and "Open thread" on a subagent row.
- Everything else behaves as in the normal web app.

## Web → Quest

The Android `@JavascriptInterface` object is named `SSHCodeQuest`. Every method takes one JSON string. Check for it with `typeof window.SSHCodeQuest === "object"`.

- **`ready(json)`** `{ "v": 1, "role": "overview" | "thread" | "new", "path": "/..." }`
  - Sent once the route has rendered.
- **`postThreads(json)`**, only from the panel designated by `sshcodeFeed=1`, regardless of role. A full snapshot, sent on change (debounced ~300 ms) and every 30 s:
  ```json
  { "v": 1, "threads": [
    { "environmentId": "…", "threadId": "…", "title": "…",
      "harness": "claude" | "codex" | "grok" | "muse" | null,
      "state": "idle" | "working" | "waiting" | "done" | "failed",
      "needsUser": false, "updatedAt": "2026-10-19T20:00:00.000Z" } ] }
  ```
  - `state` and `harness` use the same logic as the sidebar status and the harness mascots (`harnessMascotForDriver`, `harnessMascotTurnState`).
  - `needsUser` is true while the chat waits on the user: a pending question or approval.
  - Only active chats are included (not archived or settled), at most 40. Ones that need the user come first, then working ones, then the most recent.
- **`panelState(json)`**, from each panel about its own persisted chat, on change (including `new` panels after promotion):
  - `{ "v": 1, "environmentId", "threadId", "title", "harness", "state", "needsUser" }`
  - The home branches only after this carries a persisted thread id matching its rendered path, never from `ready` alone.
- **`openThread(json)`** `{ "environmentId": "…", "threadId": "…", "title": "…" }`

## Quest → web

The Quest calls `window.dispatchEvent(new CustomEvent("sshcode-quest", { detail }))` through `evaluateJavascript`. The web listens only in panel mode. `detail` is one of:

- `{ "type": "insertText", "text": "…" }`: focus this panel's composer and insert the text at the caret. Used by dictation.
- `{ "type": "send" }`: send the composer, exactly as the send button does.
- `{ "type": "focusComposer" }`

## Pairing

- All WebViews share Android's `CookieManager`, so pairing once covers every panel.
- The app accepts a `VIEW` intent whose data is a pairing URL, `http(s)://host:port/pair#token=…`. It:
  1. saves the URL's origin as the server;
  2. loads the pairing URL in a panel;
  3. once the server redirects into the app, opens the central home panel.
- Install-time pairing uses `adb shell am start -a android.intent.action.VIEW -n com.example.sshcode.quest/.MainActivity -d '<pairUrl>'`.
- Pairing tokens are secrets. Never log them, print them, or put them in screenshots or notes.
- The passthrough QR scanner uses the same pairing flow. It never persists frames or decoded tokens.
