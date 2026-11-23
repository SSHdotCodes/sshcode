#!/usr/bin/env node
// Reads the server CLI's pairing JSON from stdin. Never echoes the link or adb output.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const value = JSON.parse(input);
  const url = value.pairUrl;
  if (typeof url !== "string") throw new Error("Pairing JSON must contain pairUrl.");
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.pathname !== "/pair" ||
    !new URLSearchParams(parsed.hash.slice(1)).get("token")
  )
    throw new Error("Invalid pairing link.");
  // adb passes its arguments through a remote shell. Quote for that shell, not the host shell.
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const adb = process.env.ADB ?? `${NodeOS.homedir()}/Library/Android/sdk/platform-tools/adb`;
  const result = NodeChildProcess.spawnSync(
    adb,
    [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-n",
      "com.example.sshcode.quest/.MainActivity",
      "-d",
      quote(url),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0 || /Error:|Exception/.test(output))
    throw new Error("adb could not start SSHCode. Check the headset connection and app install.");
  console.log("Pairing intent delivered. Check the headset.");
} catch {
  // Do not forward JSON parser errors; some Node versions include input snippets.
  console.error(
    "Could not deliver pairing intent. Check the JSON, adb connection and app install.",
  );
  process.exitCode = 1;
}
