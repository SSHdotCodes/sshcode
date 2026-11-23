# SSHCode for Quest

A sideloaded Quest 3 mixed reality shell for the real SSHCode web UI. Android View
panels host WebViews through Meta Spatial SDK 0.14.0. This project is independent
of the pnpm workspace and does not require Meta Spatial Editor.

## Build and install

Use JDK 21 and Android SDK 36. From the repository root:

```sh
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
apps/quest/gradlew -p apps/quest :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest
"$ANDROID_HOME/platform-tools/adb" install -r apps/quest/app/build/outputs/apk/debug/app-debug.apk
"$ANDROID_HOME/platform-tools/adb" shell am start -n com.example.sshcode.quest/.MainActivity
```

The APK uses the normal Android debug key. Build outputs and local SDK paths are
ignored. No server credentials are packaged in the APK. Only arm64 is built.

## Pair

Create a pairing link on the SSHCode server. Pipe the CLI JSON directly to the
helper. Pairing URLs are secrets; do not copy them into logs, terminal commands,
screenshots or notes. The helper suppresses adb's URL echo.

For a **throwaway** development server on port 3997, run from the repo root:

```sh
"$ANDROID_HOME/platform-tools/adb" reverse tcp:3997 tcp:3997
HOME=/tmp/sshcode-quest-qa/home node apps/server/src/bin.ts auth pairing create \
  --base-dir /tmp/sshcode-quest-qa/t3 --ttl 15m --label "Quest QA" \
  --base-url http://localhost:3997 --json | node apps/quest/scripts/pair.mjs
```

Use the actual server origin for normal network pairing. HTTP LAN servers work;
HTTPS uses system certificate authorities. All panels share Android cookies.
The app stores only the origin, never the pairing token. The first panel explains
pairing if no server is configured. Settings can reconnect or forget this app's
saved server and cookies.

## Panels

Home stays in the centre with the normal new-thread mascot, greeting and composer.
Sending its draft moves that same WebView into the side arc, preserving subsequent
input, and restores a fresh home in its place. Overview opens as a side window
from the grid icon on Home or the agents strip and is closed by default.

Rounded Android View content is clipped inside a transparent Spatial SDK panel
layer, with a subtle edge. The public SDK's quad options do not expose corner
resizing, so compact −/+ icons resize between the same physical bounds. Select
the slim grab bar below a window, grip/pinch to move it, then select it again to
lock and interact with the page. The small icon toolbar provides dictation,
reload and close. Settings on Home includes Reset layout here for the seated gaze.

Default panels are 1.15 × 0.83 m at about 1.55 m, 1000 dp/m, rendered at 1.5×
resolution (about 1725 × 1245 pixels before resizing). Physical size can vary
between 0.7× and 1.4×. Legibility and interaction still need a real headset pass.

At most four WebViews run at once. Extra windows keep half-resolution snapshots;
tapping their title or snapshot reloads them. Page-local unsaved input may need
re-entry after suspension. Home stays live to feed status updates through `sshcodeFeed=1`. There is a
12-window cap; at the cap, a home submission replaces the oldest suspended
window so its live chat and a fresh home both remain visible. Layout and open chats are saved separately per server; closed
chats retain their placement. Placement uses LOCAL_FLOOR tracking relative to the
recentred origin. The public SDK offers scene-anchor discovery, but does not
expose a supported persistent custom-anchor save/restore API, so room-persistent
anchors are not claimed.

File attachments use Android's system picker. Same-server downloads go to the
headset's Downloads through DownloadManager with the shared session cookie.
Video/audio playback and custom full-screen video remain inside the panel. Links
to other origins open in the system browser. Network subresources are restricted
to the paired origin because the JavaScript interface is visible to frames;
external embeds should be opened in the browser. Blob downloads require the web
app to expose a server download URL. Capture permissions are denied to web pages.

## Verification and logs

Run the bridge's real Android WebView test on a connected Quest:

```sh
apps/quest/gradlew -p apps/quest :app:connectedDebugAndroidTest
"$ANDROID_HOME/platform-tools/adb" logcat -s SSHCodeQuest
"$ANDROID_HOME/platform-tools/adb" shell dumpsys meminfo com.example.sshcode.quest
"$ANDROID_HOME/platform-tools/adb" shell dumpsys thermalservice
```

The JVM tests cover pairing validation, safe route encoding, bounded bridge
messages and safe JavaScript event encoding. The instrumented test checks actual
JS → Kotlin → JS delivery. Do not capture logcat while delivering a real pairing
URL; Android's activity manager may log incoming intents outside this app.

Sources: [Meta Spatial SDK release](https://developers.meta.com/vr/downloads/package/meta-spatial-sdk/),
[official samples](https://github.com/meta-quest/Meta-Spatial-SDK-Samples), including
StarterSample, MixedRealitySample and the Focus WebView showcase.

## Agents

An agents strip sits above Home and follows its placement. Chips show active
chats, harness mascots and states; selecting one opens that chat. Chat mascots
stand in a small header on their panel. The build generates the sprite manifest
and copies the original WebP sheets from the web app, preserving frame durations
and Clawd's nearest-neighbour pixels. Idle sprites rest after one cycle; chip
sprites are static to keep the desk quiet.

A false → true `needsUser` transition plays a soft panel-positioned chime once,
briefly lights the edge, and uses the mascot's greeting animation. The initial
snapshot establishes state without sounding forty startup notifications.

## Voice

Hold the **microphone icon** with the pointer/hand pinch, or hold **A / X** while
pointing at a panel. Release to insert dictated text into that panel's composer.
A separate utterance of **“send it”** sends the composer; that phrase inside a
longer sentence is inserted as text. Even an early final result waits for release.
Nothing listens until you press. Partial transcripts appear in a bubble below
the window. Moving focus, closing the target or leaving the app cancels dictation.

The first use requests microphone permission and explains how to start again.
Dictation binds Meta's installed system recognizer through the standard Android
`SpeechRecognizer` API, preferring the default Meta component and falling back to
the second Meta component on binding errors. Horizon can hide its system services
from app-level package queries, so recognition uses explicit component bindings. It requests offline results;
no external speech service or API key is configured. Unsupported headsets keep
keyboard input available. Logs include binding, lifecycle and error codes, never
transcript text. An eight-second final-result timeout lets the next hold retry.

## Camera pairing and device QA

Choose **Scan pairing QR** on first run or in Settings. On Quest 3/3S with a recent
Horizon OS, grant `horizonos.permission.HEADSET_CAMERA`, then look at the pairing QR
on your monitor. The scanner selects a passthrough RGB camera using Meta's vendor
tags, decodes QR frames with ZXing Core, and uses the same pairing flow. Select
the scan action again to stop. Camera capture stops after a match or when the app
loses focus. Frames and decoded links are never written to disk or displayed in
logs. No Google Play services are used.

CPU-side scene tick frequency, display refresh, app PSS and thermal status are
logged every 30 seconds under `SSHCodeQuest`. Scene ticks are not compositor FPS;
use the headset's VrApi frame counters for frame timing. The 72 Hz setting is a
requested display rate, not a measured frame rate. The four-live-WebView cap
includes Home; extra chat windows are suspended as described above.

```sh
node --test apps/quest/scripts/pair.test.mjs
```

Camera reference: [Meta Passthrough Camera API](https://developers.meta.com/vr/documentation/native/android/pca-native-overview/).
