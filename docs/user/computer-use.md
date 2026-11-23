# Computer use

Computer use lets agents control macOS apps on an environment with mouse and
keyboard input. It works across providers, so an instructed task can use the
apps it needs without separate approval cards for each app or action.

The apps run on the machine hosting the environment. From the mobile app or a
remote browser, you control that host rather than the device you are holding.
For iOS Simulator and Android Emulator control, use the Device panel instead.

## Turn on Computer use

Open **Settings → Computer use**, choose an environment, and turn on **Enable
Computer use**. It is off by default and the choice applies to that environment.

The status section shows whether the computer-use driver is installed and
whether the operating system has granted the permissions it needs. If setup is
needed, choose **Set up** and follow the macOS prompt for Accessibility or
Screen Recording. **Refresh** checks the host again after you change something
in System Settings.

## Share control

One agent controls the computer at a time; other threads wait for control. The
status section identifies the active thread and app, along with any queued
threads. When Computer use is enabled, a small status button in the thread
header shows whether the computer is ready, controlled by this or another
thread, queued, or under your control. Choose it to open these settings.

Choose **Take control** to stop and revoke all agent mouse and keyboard input.
Agent access stays paused while you use the computer. Choose **Resume agent
access** when agents may continue.

## Limit app access

All apps are available by default after you enable Computer use. To exclude
specific apps, enter their bundle or application identifiers under **Blocked
app identifiers**, one per line, and save. For example, Safari's bundle
identifier is `com.apple.Safari`. Leave the list empty to allow every app.

Turn off **Enable Computer use** to stop making computer control available to
agents on the environment.
