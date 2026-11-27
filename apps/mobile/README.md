# SSHCode Mobile

The SSHCode iPhone and Android app connects to any SSHCode server (the desktop app, or
a server built from source on another machine) and controls its agents remotely. It is not in an app store:
build it from source.

> [!NOTE]
> The app uses native modules, so Expo Go cannot run it. Build the dev client or a Release app.

This app has three variants:

- `development`: Expo dev client, installable side by side as `SSHCode Dev`
  (`<bundle id>.dev`, links `sshcode-dev://`)
- `preview`: persistent internal preview build as `SSHCode Preview`
  (`<bundle id>.preview`, links `sshcode-preview://`)
- `production`: release build as `SSHCode` (`<bundle id>`, links `sshcode://`, the same
  scheme as the desktop app)

Run commands from `apps/mobile`.

## Build identity

The app's identity comes from the repository-root `.env` (or `.env.local`), never from a
file in `apps/mobile`. Every value is optional for a simulator build:

| Variable                       | Used for                                                     | Default                         |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------- |
| `T3CODE_IOS_BUNDLE_ID`         | Bundle id and Android package base. Must be one you own.     | `io.github.sshdotcodes.sshcode` |
| `T3CODE_APPLE_TEAM_ID`         | Pins signing to a paid Apple Developer team.                 | unset: Xcode asks               |
| `T3CODE_IOS_PERSONAL_TEAM`     | `1` builds without capabilities a free Apple ID cannot sign. | unset                           |
| `T3CODE_EAS_PROJECT_ID`        | Your own EAS project: cloud builds and OTA updates.          | unset: no OTA updates           |
| `T3CODE_EXPO_OWNER`            | The Expo account or organization that owns that project.     | unset                           |
| `T3CODE_IOS_ASSOCIATED_DOMAIN` | Passkeys and universal links on a domain you control.        | unset: none                     |

The default id is reserved for SSHCode. For a separately signed build, set your own reverse-DNS id (for example `com.yourname.sshcode`) before you
install on a phone.

Public builds include T3 Connect, T3's hosted service. Use email sign-in (a code or password);
social sign-in only redirects to the official app's `t3code://` callback. For direct pairing,
use your network or Tailscale. For a self-hosted relay see [`infra/relay`](../../infra/relay).

## Build from source on an iPhone

You need a Mac with Xcode, Node 24 and pnpm, and the repository installed with `pnpm install`
from the root.

### With a free Apple ID (Xcode Personal Team)

A free Apple ID signs apps for your own devices for seven days at a time. It cannot sign
the widget and share extensions, push notifications or Sign in with Apple, so opt into the
reduced build:

1. In Xcode, open Settings → Accounts and add your Apple ID. A "Personal Team" appears.
2. Put a bundle id you own in the root `.env`:

   ```bash
   T3CODE_IOS_BUNDLE_ID=com.yourname.sshcode
   T3CODE_IOS_PERSONAL_TEAM=1
   ```

3. Connect the iPhone, turn on Developer Mode (Settings → Privacy & Security), and build a
   self-contained Release app that does not need Metro:

   ```bash
   vp run ios:release
   ```

   When Xcode asks for a team, choose your Personal Team.

4. On the phone, trust the developer in Settings → General → VPN & Device Management.
   Rebuild every seven days, or when the app stops opening.

### With a paid Apple Developer account

A paid team signs every capability, including the widgets, the share extension and push
notifications.

1. Find your team id at developer.apple.com → Membership.
2. In the root `.env`:

   ```bash
   T3CODE_IOS_BUNDLE_ID=com.yourname.sshcode
   T3CODE_APPLE_TEAM_ID=ABCDE12345
   ```

3. `vp run ios:release` builds and installs it. Xcode's automatic signing creates the app ids
   and the app group (`group.<bundle id>`) the extensions share.

For TestFlight or EAS builds, create your own Expo project, set `T3CODE_EAS_PROJECT_ID` and
`T3CODE_EXPO_OWNER`, and run the `eas:*` scripts below.

### Pair with a server

Open SSHCode on your computer, go to Settings → Connections and show a pairing QR code.
Scan it from the phone's Add machine screen. The phone must reach the computer: the same
Wi-Fi, Tailscale, or T3 Connect when the build has it.

## Development

For simulator/emulator development, select and boot a device, then ensure its native client matches
this checkout before starting Metro:

```bash
node ../../scripts/mobile-native-client.ts ensure ios <simulator-udid>
# Or: node ../../scripts/mobile-native-client.ts ensure android <emulator-serial>
vp run dev:client
```

The helper compares a local Expo fingerprint and the installed binary with its last successful
build record. It builds and installs missing, stale, or unverified clients and reuses matching ones.
Use `check` instead of `ensure` for a read-only decision: exit 0 means compatible, 2 means a build is
needed, and 1 means an operational error. Run it on the simulator host; no EAS login is required.
An externally installed client is unverified until the helper builds it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

With a Personal Team, set `T3CODE_IOS_PERSONAL_TEAM=1` as described above; the dev client
is then `<bundle id>.dev` without the widget and share extensions.

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

EAS builds need your own Expo project (`T3CODE_EAS_PROJECT_ID`, `T3CODE_EXPO_OWNER`). To use your own relay, override the four public Connect identifiers in the EAS build environment.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
