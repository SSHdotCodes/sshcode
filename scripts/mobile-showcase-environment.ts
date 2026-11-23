// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This host-side fixture creates an isolated local SSHCode environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const SHOWCASE_PROJECT_ID = "t3code";
export const SHOWCASE_THREAD_ID = "remote-command-center";
export const SHOWCASE_TERMINAL_ID = "term-1";

export const SHOWCASE_SCENES = [
  "threads",
  "thread",
  "terminal",
  "review",
  "environments",
  "agent-activity",
] as const;
export type ShowcaseScene = (typeof SHOWCASE_SCENES)[number];

const PROJECTOR_NAMES = [
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.thread-turns",
  "projection.checkpoints",
  "projection.pending-approvals",
] as const;

const MODEL_SELECTION = JSON.stringify({ instanceId: "codex", model: "gpt-5.4" });
const PROJECT_SCRIPTS = JSON.stringify([
  {
    id: "dev",
    name: "Dev",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
  },
  {
    id: "test",
    name: "Tests",
    command: "pnpm test",
    icon: "test",
    runOnWorktreeCreate: false,
  },
]);

const SHOWCASE_TERMINAL_PROMPT =
  "\u001b[1;32m→\u001b[0m \u001b[1;36mt3code\u001b[0m \u001b[1;34mgit:(\u001b[1;31mfeat/remote-command-center\u001b[1;34m)\u001b[0m \u001b[1;33m✗\u001b[0m ";

// A dev-server startup mirroring the web settings' terminal font preview:
// zsh-style prompt, brand line, addresses, the thread's 612-test summary,
// and a READY badge, so the scene exercises bold, dim, underline, the six
// accent colors, and a background cell.
export const SHOWCASE_TERMINAL_BUFFER = [
  `${SHOWCASE_TERMINAL_PROMPT}vpr dev`,
  "",
  "  \u001b[1;32mVITE\u001b[0m \u001b[32mv7.1.1\u001b[0m  \u001b[2mready in\u001b[0m \u001b[1m1.24s\u001b[0m",
  "",
  "  \u001b[32m→\u001b[0m  \u001b[2mLocal:\u001b[0m    \u001b[4;36mhttp://127.0.0.1:5173/\u001b[0m",
  "  \u001b[32m→\u001b[0m  \u001b[2mNetwork:\u001b[0m  \u001b[4;36mhttp://192.168.1.24:5173/\u001b[0m",
  "  \u001b[32m→\u001b[0m  \u001b[2mProject:\u001b[0m  \u001b[1mt3code\u001b[0m \u001b[2m— ~/Code/t3code\u001b[0m",
  "",
  "  \u001b[32m✓ 612 passed\u001b[0m   \u001b[33m△ 2 warnings\u001b[0m   \u001b[31m✗ 0 failed\u001b[0m",
  "",
  "  \u001b[42;30m READY \u001b[0m \u001b[2mwatching for changes — press\u001b[0m \u001b[1mq\u001b[0m \u001b[2mto quit\u001b[0m",
  "",
  SHOWCASE_TERMINAL_PROMPT,
].join("\r\n");

const BASE_ENVIRONMENT_PRESENCE = `export function environmentLabel(count: number): string {
  return \`${"${count}"} environments\`;
}
`;

const UPDATED_ENVIRONMENT_PRESENCE = `const PULSE = ["✦", "✧", "·", "✧"] as const;

export function environmentLabel(connected: number, total: number, frame: number): string {
  const pulse = PULSE[frame % PULSE.length];
  return \`${"${pulse} ${connected}/${total}"} ready\`;
}
`;

const REMOTE_HANDOFF_CARD = `import { View, Text } from "react-native";

export function RemoteHandoffCard(props: { machine: string; latencyMs: number }) {
  return (
    <View className="rounded-2xl bg-surface-2 p-4">
      <Text className="font-semibold">Ready on {props.machine}</Text>
      <Text className="text-success">Handoff in {props.latencyMs}ms</Text>
    </View>
  );
}
`;

const PROJECT_FAVICONS = {
  t3code: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="10" fill="#000"/>
  <path d="M68.15 36.71 L67.88 36.35 L67.54 35.92 L67.20 35.51 L66.84 35.10 L66.48 34.70 L66.11 34.31 L65.72 33.92 L65.33 33.55 L64.93 33.19 L64.52 32.83 L64.11 32.48 L63.68 32.15 L63.25 31.82 L62.81 31.50 L62.36 31.19 L61.91 30.90 L61.45 30.61 L60.99 30.33 L60.51 30.06 L60.04 29.80 L59.55 29.55 L59.06 29.32 L58.57 29.09 L58.07 28.87 L57.57 28.66 L57.06 28.47 L56.54 28.28 L56.03 28.11 L55.51 27.94 L54.99 27.79 L54.46 27.64 L53.93 27.51 L53.40 27.39 L52.86 27.28 L52.32 27.17 L51.79 27.08 L51.24 27.00 L50.70 26.94 L50.16 26.88 L49.61 26.83 L49.07 26.79 L48.52 26.77 L47.97 26.75 L47.43 26.75 L46.88 26.76 L46.33 26.77 L45.79 26.80 L45.24 26.84 L44.70 26.89 L44.15 26.95 L43.61 27.03 L43.07 27.11 L42.53 27.20 L41.99 27.30 L41.46 27.42 L40.93 27.54 L40.40 27.68 L39.87 27.83 L39.35 27.98 L38.83 28.15 L38.32 28.33 L37.81 28.52 L37.30 28.72 L36.80 28.93 L36.30 29.15 L35.81 29.38 L35.32 29.62 L34.84 29.87 L34.36 30.13 L33.89 30.40 L33.42 30.68 L32.97 30.98 L32.51 31.28 L32.07 31.59 L31.63 31.91 L31.20 32.24 L30.78 32.58 L30.37 32.92 L29.96 33.28 L29.56 33.65 L29.17 34.03 L28.79 34.41 L28.42 34.80 L28.06 35.21 L27.71 35.62 L27.37 36.04 L27.04 36.46 L26.72 36.90 L26.41 37.34 L26.11 37.79 L25.82 38.25 L25.54 38.71 L25.28 39.18 L25.02 39.66 L24.78 40.15 L24.56 40.64 L24.34 41.13 L24.14 41.63 L23.95 42.14 L23.77 42.65 L23.61 43.17 L23.46 43.69 L23.33 44.21 L23.21 44.74 L23.10 45.27 L23.01 45.80 L22.93 46.34 L22.86 46.88 L22.81 47.41 L22.78 47.95 L22.76 48.50 L22.75 49.04 L22.76 49.58 L22.78 50.12 L22.82 50.66 L22.87 51.20 L22.94 51.73 L23.02 52.27 L23.11 52.80 L23.22 53.33 L23.34 53.86 L23.48 54.38 L23.63 54.90 L23.80 55.42 L23.97 55.93 L24.17 56.43 L24.37 56.93 L24.59 57.43 L24.82 57.92 L25.06 58.40 L25.31 58.88 L25.58 59.35 L25.86 59.81 L26.15 60.27 L26.45 60.72 L26.76 61.16 L27.08 61.59 L27.41 62.02 L27.76 62.44 L28.11 62.85 L28.47 63.25 L28.84 63.64 L29.22 64.03 L29.62 64.40 L30.01 64.77 L30.42 65.12 L30.84 65.47 L31.26 65.81 L31.69 66.14 L32.13 66.46 L32.57 66.77 L33.03 67.06 L33.49 67.35 L33.95 67.63 L34.42 67.90 L34.90 68.16 L35.38 68.41 L35.87 68.65 L36.37 68.88 L36.86 69.10 L37.37 69.31 L37.87 69.51 L38.39 69.69 L38.90 69.87 L39.42 70.04 L39.94 70.19 L40.47 70.34 L41.00 70.47 L41.53 70.60 L42.07 70.71 L42.60 70.81 L43.14 70.90 L43.68 70.99 L44.22 71.06 L44.77 71.11 L45.31 71.16 L45.86 71.20 L46.41 71.23 L46.95 71.24 L47.43 71.25 L47.76 71.25 L48.02 71.26 L48.28 71.27 L48.54 71.29 L48.80 71.31 L49.06 71.34 L49.31 71.38 L49.57 71.41 L49.82 71.46 L50.07 71.50 L50.32 71.56 L50.57 71.62 L50.81 71.68 L51.06 71.74 L51.30 71.82 L51.53 71.89 L51.77 71.97 L52.00 72.06 L52.23 72.15 L52.45 72.24 L52.67 72.34 L52.89 72.44 L53.10 72.54 L53.31 72.65 L53.51 72.76 L53.71 72.87 L53.91 72.99 L54.10 73.11 L54.29 73.24 L54.47 73.36 L54.65 73.49 L54.82 73.62 L54.99 73.76 L55.15 73.89 L55.31 74.03 L55.46 74.17 L55.61 74.31 L55.75 74.46 L55.89 74.60 L56.02 74.75 L56.15 74.89 L56.27 75.04 L56.39 75.19 L56.50 75.34 L56.60 75.49 L56.70 75.64 L56.80 75.80 L56.89 75.95 L56.98 76.10 L57.06 76.25 L57.14 76.41 L57.21 76.56 L57.28 76.71 L57.34 76.87 L57.40 77.02 L57.45 77.17 L57.50 77.32 L57.54 77.48 L57.58 77.63 L57.62 77.78 L57.65 77.93 L57.67 78.08 L57.70 78.23 L57.72 78.39 L57.73 78.54 L57.74 78.69 L57.75 78.84 L57.75 78.99 L57.75 79.14 L57.74 79.29 L57.73 79.44 L57.72 79.59 L57.70 79.75 L57.68 79.90 L57.65 80.05 L57.62 80.20 L57.59 80.35 L57.55 80.50 L57.50 80.66 L57.46 80.81 L57.40 80.96 L57.35 81.11 L57.28 81.27 L57.22 81.42 L57.15 81.57 L57.07 81.73 L56.99 81.88 L56.90 82.03 L56.81 82.18 L56.72 82.34 L56.62 82.49 L56.51 82.64 L56.40 82.79 L56.28 82.94 L56.16 83.09 L56.04 83.23 L55.91 83.38 L55.77 83.52 L55.63 83.67 L55.48 83.81 L55.33 83.95 L55.17 84.09 L55.01 84.22 L54.84 84.36 L54.67 84.49 L54.49 84.62 L54.31 84.75 L54.13 84.87 L53.94 84.99 L53.74 85.11 L53.54 85.23 L53.34 85.34 L53.13 85.45 L52.92 85.55 L52.70 85.65 L52.48 85.75 L52.26 85.84 L52.03 85.93 L51.80 86.02 L51.56 86.10 L51.33 86.17 L51.09 86.25 L50.85 86.31 L50.60 86.38 L50.35 86.43 L50.11 86.49 L49.85 86.54 L49.60 86.58 L49.35 86.62 L49.09 86.65 L48.83 86.68 L48.57 86.71 L48.32 86.72 L48.06 86.74 L47.80 86.75 L47.54 86.75 L47.27 86.75 L47.01 86.74 L46.75 86.73 L46.50 86.71 L46.24 86.69 L45.98 86.66 L45.72 86.63 L45.47 86.59 L45.21 86.55 L44.96 86.50 L44.71 86.45 L44.46 86.39 L44.22 86.33 L43.98 86.26 L43.74 86.19 L43.50 86.12 L43.26 86.04 L43.03 85.95 L42.80 85.87 L42.58 85.77 L42.36 85.68 L42.14 85.58 L41.93 85.47 L41.72 85.37 L41.51 85.26 L41.31 85.14 L41.12 85.02 L40.92 84.90 L40.74 84.78 L40.55 84.65 L40.38 84.53 L40.20 84.39 L40.03 84.26 L39.87 84.13 L39.71 83.99 L39.56 83.85 L39.41 83.71 L39.27 83.56 L39.13 83.42 L39.00 83.27 L38.87 83.13 L38.75 82.98 L38.63 82.83 L38.47 82.61 L37.85 81.89 L37.14 81.25 L36.36 80.72 L35.52 80.29 L34.62 79.97 L33.69 79.77 L32.75 79.70 L31.80 79.75 L30.87 79.92 L29.97 80.22 L29.11 80.63 L28.32 81.14 L27.60 81.76 L26.96 82.46 L26.43 83.25 L26.00 84.09 L25.68 84.99 L25.48 85.91 L25.41 86.86 L25.46 87.81 L25.63 88.74 L25.93 89.64 L26.34 90.50 L26.85 91.29 L27.12 91.65 L27.46 92.08 L27.80 92.49 L28.16 92.90 L28.52 93.30 L28.89 93.69 L29.28 94.08 L29.67 94.45 L30.07 94.81 L30.48 95.17 L30.89 95.52 L31.32 95.85 L31.75 96.18 L32.19 96.50 L32.64 96.81 L33.09 97.10 L33.55 97.39 L34.01 97.67 L34.49 97.94 L34.96 98.20 L35.45 98.45 L35.94 98.68 L36.43 98.91 L36.93 99.13 L37.43 99.34 L37.94 99.53 L38.46 99.72 L38.97 99.89 L39.49 100.06 L40.01 100.21 L40.54 100.36 L41.07 100.49 L41.60 100.61 L42.14 100.72 L42.68 100.83 L43.21 100.92 L43.76 101.00 L44.30 101.06 L44.84 101.12 L45.39 101.17 L45.93 101.21 L46.48 101.23 L47.03 101.25 L47.57 101.25 L48.12 101.24 L48.67 101.23 L49.21 101.20 L49.76 101.16 L50.30 101.11 L50.85 101.05 L51.39 100.97 L51.93 100.89 L52.47 100.80 L53.01 100.70 L53.54 100.58 L54.07 100.46 L54.60 100.32 L55.13 100.17 L55.65 100.02 L56.17 99.85 L56.68 99.67 L57.19 99.48 L57.70 99.28 L58.20 99.07 L58.70 98.85 L59.19 98.62 L59.68 98.38 L60.16 98.13 L60.64 97.87 L61.11 97.60 L61.58 97.32 L62.03 97.02 L62.49 96.72 L62.93 96.41 L63.37 96.09 L63.80 95.76 L64.22 95.42 L64.63 95.08 L65.04 94.72 L65.44 94.35 L65.83 93.97 L66.21 93.59 L66.58 93.20 L66.94 92.79 L67.29 92.38 L67.63 91.96 L67.96 91.54 L68.28 91.10 L68.59 90.66 L68.89 90.21 L69.18 89.75 L69.46 89.29 L69.72 88.82 L69.98 88.34 L70.22 87.85 L70.44 87.36 L70.66 86.87 L70.86 86.37 L71.05 85.86 L71.23 85.35 L71.39 84.83 L71.54 84.31 L71.67 83.79 L71.79 83.26 L71.90 82.73 L71.99 82.20 L72.07 81.66 L72.14 81.12 L72.19 80.59 L72.22 80.05 L72.24 79.50 L72.25 78.96 L72.24 78.42 L72.22 77.88 L72.18 77.34 L72.13 76.80 L72.06 76.27 L71.98 75.73 L71.89 75.20 L71.78 74.67 L71.66 74.14 L71.52 73.62 L71.37 73.10 L71.20 72.58 L71.03 72.07 L70.83 71.57 L70.63 71.07 L70.41 70.57 L70.18 70.08 L69.94 69.60 L69.69 69.12 L69.42 68.65 L69.14 68.19 L68.85 67.73 L68.55 67.28 L68.24 66.84 L67.92 66.41 L67.59 65.98 L67.24 65.56 L66.89 65.15 L66.53 64.75 L66.16 64.36 L65.78 63.97 L65.38 63.60 L64.99 63.23 L64.58 62.88 L64.16 62.53 L63.74 62.19 L63.31 61.86 L62.87 61.54 L62.43 61.23 L61.97 60.94 L61.51 60.65 L61.05 60.37 L60.58 60.10 L60.10 59.84 L59.62 59.59 L59.13 59.35 L58.63 59.12 L58.14 58.90 L57.63 58.69 L57.13 58.49 L56.61 58.31 L56.10 58.13 L55.58 57.96 L55.06 57.81 L54.53 57.66 L54.00 57.53 L53.47 57.40 L52.93 57.29 L52.40 57.19 L51.86 57.10 L51.32 57.01 L50.78 56.94 L50.23 56.89 L49.69 56.84 L49.14 56.80 L48.59 56.77 L48.05 56.76 L47.57 56.75 L47.24 56.75 L46.98 56.74 L46.72 56.73 L46.46 56.71 L46.20 56.69 L45.94 56.66 L45.69 56.62 L45.43 56.59 L45.18 56.54 L44.93 56.50 L44.68 56.44 L44.43 56.38 L44.19 56.32 L43.94 56.26 L43.70 56.18 L43.47 56.11 L43.23 56.03 L43.00 55.94 L42.77 55.85 L42.55 55.76 L42.33 55.66 L42.11 55.56 L41.90 55.46 L41.69 55.35 L41.49 55.24 L41.29 55.13 L41.09 55.01 L40.90 54.89 L40.71 54.76 L40.53 54.64 L40.35 54.51 L40.18 54.38 L40.01 54.24 L39.85 54.11 L39.69 53.97 L39.54 53.83 L39.39 53.69 L39.25 53.54 L39.11 53.40 L38.98 53.25 L38.85 53.11 L38.73 52.96 L38.61 52.81 L38.50 52.66 L38.40 52.51 L38.30 52.36 L38.20 52.20 L38.11 52.05 L38.02 51.90 L37.94 51.75 L37.86 51.59 L37.79 51.44 L37.72 51.29 L37.66 51.13 L37.60 50.98 L37.55 50.83 L37.50 50.68 L37.46 50.52 L37.42 50.37 L37.38 50.22 L37.35 50.07 L37.33 49.92 L37.30 49.77 L37.28 49.61 L37.27 49.46 L37.26 49.31 L37.25 49.16 L37.25 49.01 L37.25 48.86 L37.26 48.71 L37.27 48.56 L37.28 48.41 L37.30 48.25 L37.32 48.10 L37.35 47.95 L37.38 47.80 L37.41 47.65 L37.45 47.50 L37.50 47.34 L37.54 47.19 L37.60 47.04 L37.65 46.89 L37.72 46.73 L37.78 46.58 L37.85 46.43 L37.93 46.27 L38.01 46.12 L38.10 45.97 L38.19 45.82 L38.28 45.66 L38.38 45.51 L38.49 45.36 L38.60 45.21 L38.72 45.06 L38.84 44.91 L38.96 44.77 L39.09 44.62 L39.23 44.48 L39.37 44.33 L39.52 44.19 L39.67 44.05 L39.83 43.91 L39.99 43.78 L40.16 43.64 L40.33 43.51 L40.51 43.38 L40.69 43.25 L40.87 43.13 L41.06 43.01 L41.26 42.89 L41.46 42.77 L41.66 42.66 L41.87 42.55 L42.08 42.45 L42.30 42.35 L42.52 42.25 L42.74 42.16 L42.97 42.07 L43.20 41.98 L43.44 41.90 L43.67 41.83 L43.91 41.75 L44.15 41.69 L44.40 41.62 L44.65 41.57 L44.89 41.51 L45.15 41.46 L45.40 41.42 L45.65 41.38 L45.91 41.35 L46.17 41.32 L46.43 41.29 L46.68 41.28 L46.94 41.26 L47.20 41.25 L47.46 41.25 L47.73 41.25 L47.99 41.26 L48.25 41.27 L48.50 41.29 L48.76 41.31 L49.02 41.34 L49.28 41.37 L49.53 41.41 L49.79 41.45 L50.04 41.50 L50.29 41.55 L50.54 41.61 L50.78 41.67 L51.02 41.74 L51.26 41.81 L51.50 41.88 L51.74 41.96 L51.97 42.05 L52.20 42.13 L52.42 42.23 L52.64 42.32 L52.86 42.42 L53.07 42.53 L53.28 42.63 L53.49 42.74 L53.69 42.86 L53.88 42.98 L54.08 43.10 L54.26 43.22 L54.45 43.35 L54.62 43.47 L54.80 43.61 L54.97 43.74 L55.13 43.87 L55.29 44.01 L55.44 44.15 L55.59 44.29 L55.73 44.44 L55.87 44.58 L56.00 44.73 L56.13 44.87 L56.25 45.02 L56.37 45.17 L56.53 45.39 L57.15 46.11 L57.86 46.75 L58.64 47.28 L59.48 47.71 L60.38 48.03 L61.31 48.23 L62.25 48.30 L63.20 48.25 L64.13 48.08 L65.03 47.78 L65.89 47.37 L66.68 46.86 L67.40 46.24 L68.04 45.54 L68.57 44.75 L69.00 43.91 L69.32 43.01 L69.52 42.09 L69.59 41.14 L69.54 40.19 L69.37 39.26 L69.07 38.36 L68.66 37.50Z" fill="#fff"/>
  <path d="M81.75 91.75 H100.75 A2.5 2.5 0 0 1 103.25 94.25 V98.75 A2.5 2.5 0 0 1 100.75 101.25 H81.75 A2.5 2.5 0 0 1 79.25 98.75 V94.25 A2.5 2.5 0 0 1 81.75 91.75Z" fill="#fff"/>
</svg>`,
  react: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#20232a"/>
  <g fill="none" stroke="#61dafb" stroke-width="2.8"><ellipse cx="32" cy="32" rx="25" ry="9"/><ellipse cx="32" cy="32" rx="25" ry="9" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="25" ry="9" transform="rotate(120 32 32)"/></g>
  <circle cx="32" cy="32" r="4.8" fill="#61dafb"/>
</svg>`,
  linux: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#f7c948"/>
  <ellipse cx="32" cy="35" rx="17" ry="22" fill="#202124"/>
  <ellipse cx="32" cy="40" rx="12" ry="14" fill="#f5f5f2"/>
  <circle cx="27" cy="24" r="5" fill="white"/><circle cx="37" cy="24" r="5" fill="white"/>
  <circle cx="28" cy="25" r="2"/><circle cx="36" cy="25" r="2"/>
  <path d="M27 31l5-4 5 4-5 4z" fill="#f28c28"/><path d="M16 55h14l-7-5zM34 55h14l-7-5z" fill="#f28c28"/>
</svg>`,
} as const;

export const SHOWCASE_PROJECTS = [
  {
    id: "t3code",
    title: "SSHCode",
    directory: "t3code",
    repositoryUrl: "https://github.com/pingdotgg/t3code.git",
    favicon: PROJECT_FAVICONS.t3code,
  },
  {
    id: "react",
    title: "React",
    directory: "react",
    repositoryUrl: "https://github.com/facebook/react.git",
    favicon: PROJECT_FAVICONS.react,
  },
  {
    id: "linux",
    title: "Linux",
    directory: "linux",
    repositoryUrl: "https://github.com/torvalds/linux.git",
    favicon: PROJECT_FAVICONS.linux,
  },
] as const;

export const SHOWCASE_ENVIRONMENTS = [
  {
    id: "moonbase-terminal",
    label: "Moonbase Terminal",
    projectIds: ["t3code"],
  },
  {
    id: "suspense-station",
    label: "Suspense Station",
    projectIds: ["react"],
  },
  {
    id: "kernel-cabin",
    label: "Kernel Cabin",
    projectIds: ["linux"],
  },
] as const;

export const SHOWCASE_THREADS = [
  {
    id: SHOWCASE_THREAD_ID,
    projectId: "t3code",
    title: "Make remote coding feel local ✦",
    branch: "feat/remote-command-center",
    minutesAgo: 3,
    request:
      "Give SSHCode a remote-first command center. Make three machines feel one tap away, keep agent work in sync, and make every handoff feel instant.",
    response:
      "SSHCode now treats every machine like it is right here in the room. ✦\n\n- Moonbase, Suspense Station, and Kernel Cabin stay live together\n- Terminal state follows you without losing a single line\n- Agent work remains perfectly in sync across devices\n- Handoffs land before your train of thought can wander\n\nI also ran the changed workspace: **612 tests passed**.",
  },
  {
    id: "pocket-command-center",
    projectId: "t3code",
    title: "Put the command center in your pocket",
    branch: "feat/pocket-command-center",
    minutesAgo: 21,
    state: "approval" as const,
    request: "Make switching between desktop, phone, and tablet feel like one continuous session.",
    response:
      "The handoff flow preserves the selected thread, terminal buffer, and working diff. The final motion treatment is ready for approval.",
  },
  {
    id: "buttery-suspense",
    projectId: "react",
    title: "Make Suspense transitions buttery",
    branch: "perf/buttery-suspense",
    minutesAgo: 12,
    state: "working" as const,
    request:
      "Trace the last few dropped frames in nested Suspense transitions and make them disappear.",
    response: null,
  },
  {
    id: "hydration-haikus",
    projectId: "react",
    title: "Turn hydration warnings into haikus",
    branch: "dev/hydration-haikus",
    minutesAgo: 44,
    request:
      "Keep hydration errors precise, but make the development copy unexpectedly delightful.",
    response:
      "The diagnostics still lead with the exact mismatch and component stack. A tiny optional haiku now closes the expanded explanation.",
    snoozeMinutes: 90,
  },
  {
    id: "beautiful-boot",
    projectId: "linux",
    title: "Make boot logs oddly beautiful",
    branch: "feat/beautiful-boot",
    minutesAgo: 34,
    state: "plan" as const,
    request:
      "Design a clearer boot timeline that remains useful over serial and never hides kernel detail.",
    response:
      "The plan groups milestones without changing the underlying log stream, preserves plain-text output, and adds zero work to the hot path.",
  },
  {
    id: "patient-penguins",
    projectId: "linux",
    title: "Teach penguins to wait patiently",
    branch: "feat/patient-penguins",
    minutesAgo: 52,
    request: "Make delayed work easier to follow without adding noise to the scheduler trace.",
    response:
      "Delayed work now carries a concise reason through the trace, so the wait is legible without changing scheduling behavior.",
    snoozeMinutes: 8 * 60,
  },
  // Finished work, settled by hand: the list keeps it as a receded tail so
  // the active block above reads as everything still in flight. The active
  // block stays small enough that the settled tail begins above the fold —
  // a store screenshot has to show that history exists, not just imply it.
  {
    id: "handoff-haptics",
    projectId: "t3code",
    title: "Tune the handoff haptics",
    branch: "feat/handoff-haptics",
    minutesAgo: 5 * 60,
    settled: true,
    request: "Give the desktop-to-phone handoff a haptic that lands with the animation.",
    response:
      "The handoff now taps once as the thread lands and stays silent on failure, so the phone never celebrates a handoff that did not happen.",
  },
  {
    id: "streaming-shell",
    projectId: "react",
    title: "Stream the shell before the data",
    branch: "feat/streaming-shell",
    minutesAgo: 28 * 60,
    settled: true,
    request: "Get the app shell painted before any data request resolves.",
    response:
      "The shell now flushes on first byte and the data boundaries hydrate underneath it, so the first paint no longer waits on the slowest query.",
  },
  {
    id: "quieter-oom",
    projectId: "linux",
    title: "Make the OOM killer explain itself",
    branch: "feat/quieter-oom",
    minutesAgo: 2 * 24 * 60,
    settled: true,
    request: "Make out-of-memory kills legible without adding a single allocation to the hot path.",
    response:
      "Kills now report the winning heuristic and the runner-up alongside the usual dump, assembled entirely from data the path already had.",
  },
] as const;

function minutesBefore(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

async function runGit(workspaceRoot: string, args: ReadonlyArray<string>): Promise<void> {
  await execFile("git", [...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Alex Rivera",
      GIT_AUTHOR_EMAIL: "alex@lumen.test",
      GIT_COMMITTER_NAME: "Alex Rivera",
      GIT_COMMITTER_EMAIL: "alex@lumen.test",
    },
  });
}

async function initializeRepository(input: {
  readonly workspaceRoot: string;
  readonly repositoryUrl: string;
  readonly commitMessage: string;
}): Promise<void> {
  await runGit(input.workspaceRoot, ["init", "-b", "main"]);
  await runGit(input.workspaceRoot, ["remote", "add", "origin", input.repositoryUrl]);
  await runGit(input.workspaceRoot, ["add", "."]);
  await runGit(input.workspaceRoot, ["commit", "-m", input.commitMessage]);
}

async function seedT3CodeWorkspace(workspaceRoot: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.join(workspaceRoot, "apps/mobile/src/features/home"), {
    recursive: true,
  });
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "package.json"),
    `${JSON.stringify({ name: "t3code", private: true, scripts: { test: "vp test" } }, null, 2)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, "favicon.svg"), PROJECT_FAVICONS.t3code);
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/environmentPresence.ts"),
    BASE_ENVIRONMENT_PRESENCE,
  );
  await initializeRepository({
    workspaceRoot,
    repositoryUrl: "https://github.com/pingdotgg/t3code.git",
    commitMessage: "Show connected environments",
  });
  await runGit(workspaceRoot, ["checkout", "-b", "feat/remote-command-center"]);
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/environmentPresence.ts"),
    UPDATED_ENVIRONMENT_PRESENCE,
  );
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/RemoteHandoffCard.tsx"),
    REMOTE_HANDOFF_CARD,
  );
}

async function seedCompanionWorkspace(input: {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly repositoryUrl: string;
  readonly favicon: string;
}): Promise<void> {
  await NodeFSP.mkdir(input.workspaceRoot, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(input.workspaceRoot, "favicon.svg"), input.favicon);
  await NodeFSP.writeFile(
    NodePath.join(input.workspaceRoot, "README.md"),
    `# ${input.title}\n\nSeeded by the SSHCode mobile screenshot harness.\n`,
  );
  await initializeRepository({
    workspaceRoot: input.workspaceRoot,
    repositoryUrl: input.repositoryUrl,
    commitMessage: `Seed ${input.title} workspace`,
  });
}

function insertThread(
  database: NodeSqlite.DatabaseSync,
  now: number,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly branch: string;
    readonly minutesAgo: number;
    readonly state?: "working" | "approval" | "plan";
    readonly settled?: boolean;
    readonly snoozeMinutes?: number;
    readonly workspaceRoot: string;
  },
): void {
  const turnId = `${input.id}-turn`;
  const updatedAt = minutesBefore(now, input.minutesAgo);
  const isWorking = input.state === "working";
  const snoozedUntil =
    input.snoozeMinutes === undefined
      ? null
      : new Date(now + input.snoozeMinutes * 60_000).toISOString();
  const snoozedAt =
    input.snoozeMinutes === undefined
      ? null
      : minutesBefore(now, Math.max(1, Math.floor(input.minutesAgo / 2)));
  database
    .prepare(
      `INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count,
        pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at,
        archived_at, deleted_at, settled_override, settled_at, snoozed_until, snoozed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.title,
      MODEL_SELECTION,
      "full-access",
      input.state === "plan" ? "plan" : "default",
      input.branch,
      input.workspaceRoot,
      turnId,
      minutesBefore(now, input.minutesAgo + 1),
      input.state === "approval" ? 1 : 0,
      input.state === "plan" ? 1 : 0,
      minutesBefore(now, input.minutesAgo + 120),
      updatedAt,
      input.settled ? "settled" : null,
      input.settled ? updatedAt : null,
      snoozedUntil,
      snoozedAt,
    );
  database
    .prepare(
      `INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
        started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
        checkpoint_files_json, source_proposed_plan_thread_id, source_proposed_plan_id
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]', NULL, NULL)`,
    )
    .run(
      input.id,
      turnId,
      isWorking ? null : `${input.id}-answer`,
      isWorking ? "running" : "completed",
      minutesBefore(now, input.minutesAgo + 2),
      minutesBefore(now, input.minutesAgo + 2),
      isWorking ? null : updatedAt,
    );
  database
    .prepare(
      `INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, provider_session_id,
        provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
      ) VALUES (?, ?, 'Codex', 'codex', NULL, NULL, 'full-access', ?, NULL, ?)`,
    )
    .run(input.id, isWorking ? "running" : "ready", isWorking ? turnId : null, updatedAt);
}

// V1 tables this seed owns. `projection_projects` is not listed: V2 still
// stores projects there, so the seed upserts its own rows instead. V2 clients
// do not read the V1 thread rows; moving the seed to V2 is tracked in
// https://github.com/pingdotgg/t3code/issues/15013.
const SEEDED_V1_TABLES = [
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_turns",
  "projection_threads",
  "projection_state",
] as const;

const SEEDED_PROJECTION_TABLES = [...SEEDED_V1_TABLES, "projection_projects"] as const;

const SEEDED_THREAD_COLUMNS = ["snoozed_until", "snoozed_at"] as const;

function hasSeedableSchema(dbPath: string): boolean {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const tableCount = database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${SEEDED_PROJECTION_TABLES.map(() => "?").join(", ")})`,
      )
      .get(...SEEDED_PROJECTION_TABLES) as { count: number };
    if (tableCount.count !== SEEDED_PROJECTION_TABLES.length) return false;

    const threadColumns = database.prepare("PRAGMA table_info(projection_threads)").all() as Array<{
      name: string;
    }>;
    const threadColumnNames = new Set(threadColumns.map((column) => column.name));
    return SEEDED_THREAD_COLUMNS.every((column) => threadColumnNames.has(column));
  } catch {
    return false;
  } finally {
    database.close();
  }
}

async function waitForSeedableSchema(dbPath: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasSeedableSchema(dbPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The environment server did not migrate ${dbPath} within ${timeoutMs}ms.`);
}

function seedDatabase(
  dbPath: string,
  workspaceRoots: ReadonlyMap<string, string>,
  projects: ReadonlyArray<(typeof SHOWCASE_PROJECTS)[number]>,
  threads: ReadonlyArray<(typeof SHOWCASE_THREADS)[number]>,
  now: number,
): void {
  // The environment server is already running against this file and keeps
  // writing (migrations, projections) while we seed, so the write lock is
  // genuinely contended — without a busy timeout `BEGIN IMMEDIATE` fails
  // instantly with SQLITE_BUSY on a loaded machine.
  const database = new NodeSqlite.DatabaseSync(dbPath, { timeout: 30_000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const table of SEEDED_V1_TABLES) {
      database.exec(`DELETE FROM ${table}`);
    }
    const insertProject = database.prepare(
      `INSERT OR REPLACE INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const [index, project] of projects.entries()) {
      const workspaceRoot = workspaceRoots.get(project.id);
      if (!workspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
      const latestThreadMinutes = Math.min(
        ...threads
          .filter((thread) => thread.projectId === project.id)
          .map((thread) => thread.minutesAgo),
      );
      insertProject.run(
        project.id,
        project.title,
        workspaceRoot,
        MODEL_SELECTION,
        PROJECT_SCRIPTS,
        minutesBefore(now, 60 * 24 * (90 - index * 12)),
        minutesBefore(now, latestThreadMinutes),
      );
    }

    for (const thread of threads) {
      const workspaceRoot = workspaceRoots.get(thread.projectId);
      if (!workspaceRoot) throw new Error(`Missing workspace root for ${thread.projectId}.`);
      insertThread(database, now, {
        ...thread,
        ...("state" in thread ? { state: thread.state } : {}),
        workspaceRoot,
      });
    }

    const insertMessage = database.prepare(
      `INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, attachments_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    );
    for (const thread of threads) {
      const turnId = `${thread.id}-turn`;
      const requestTime = minutesBefore(now, thread.minutesAgo + 5);
      insertMessage.run(
        `${thread.id}-request`,
        thread.id,
        turnId,
        "user",
        thread.request,
        requestTime,
        requestTime,
      );
      if (thread.response !== null) {
        const responseTime = minutesBefore(now, thread.minutesAgo);
        insertMessage.run(
          `${thread.id}-answer`,
          thread.id,
          turnId,
          "assistant",
          thread.response,
          responseTime,
          responseTime,
        );
      }
    }

    const turnId = `${SHOWCASE_THREAD_ID}-turn`;
    const insertActivity = database.prepare(
      `INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES (?, ?, ?, 'tool', 'tool.completed', ?, ?, ?, ?)`,
    );
    insertActivity.run(
      "trace-remote-handoff",
      SHOWCASE_THREAD_ID,
      turnId,
      "Traced the remote handoff path",
      JSON.stringify({
        itemType: "command_execution",
        title: "Traced the remote handoff path",
        detail: "Three environments, one continuous workspace",
        status: "completed",
      }),
      1,
      minutesBefore(now, 8),
    );
    insertActivity.run(
      "sync-command-center",
      SHOWCASE_THREAD_ID,
      turnId,
      "Synced the command center",
      JSON.stringify({
        itemType: "file_change",
        title: "Synced the command center",
        detail: "2 files changed · instant handoffs · calm reconnects",
        status: "completed",
      }),
      2,
      minutesBefore(now, 6),
    );
    insertActivity.run(
      "run-changed-suite",
      SHOWCASE_THREAD_ID,
      turnId,
      "Ran the changed workspace",
      JSON.stringify({
        itemType: "command_execution",
        title: "Ran the changed workspace",
        detail: "612 tests passed · 3 environments online",
        status: "completed",
      }),
      3,
      minutesBefore(now, 4),
    );

    for (const [index, projector] of PROJECTOR_NAMES.entries()) {
      database
        .prepare(
          "INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES (?, ?, ?)",
        )
        .run(projector, index + 1, minutesBefore(now, 1));
    }
    database.exec("COMMIT");
  } catch (error) {
    // A failed BEGIN (or an error SQLite already auto-rolled back) leaves no
    // transaction, and the rollback's own "cannot rollback" error would then
    // replace the one that actually explains the failure.
    try {
      database.exec("ROLLBACK");
    } catch {
      // Nothing to roll back.
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function seedShowcaseEnvironment(input: {
  readonly baseDir: string;
  readonly projectIds?: ReadonlyArray<string>;
  readonly now?: number;
}): Promise<{ readonly dbPath: string; readonly workspaceRoot: string }> {
  const now = input.now ?? Date.now();
  const selectedProjectIds = new Set(
    input.projectIds ?? SHOWCASE_PROJECTS.map((project) => project.id),
  );
  const projects = SHOWCASE_PROJECTS.filter((project) => selectedProjectIds.has(project.id));
  if (projects.length === 0) throw new Error("At least one showcase project must be selected.");
  const threads = SHOWCASE_THREADS.filter((thread) => selectedProjectIds.has(thread.projectId));
  const workspaceBase = NodePath.join(input.baseDir, "workspace");
  const workspaceRoots = new Map(
    projects.map(
      (project) => [project.id, NodePath.join(workspaceBase, project.directory)] as const,
    ),
  );
  const primaryProject =
    projects.find((project) => project.id === SHOWCASE_PROJECT_ID) ?? projects[0];
  if (!primaryProject) throw new Error("The primary showcase workspace is not configured.");
  const workspaceRoot = workspaceRoots.get(primaryProject.id);
  if (!workspaceRoot) throw new Error("The primary showcase workspace is not configured.");
  const dbPath = NodePath.join(input.baseDir, "userdata", "statev2.sqlite");
  if (primaryProject.id === SHOWCASE_PROJECT_ID) {
    await seedT3CodeWorkspace(workspaceRoot);
  }
  await Promise.all(
    projects
      .filter((project) => project.id !== SHOWCASE_PROJECT_ID)
      .map(async (project) => {
        const projectWorkspaceRoot = workspaceRoots.get(project.id);
        if (!projectWorkspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
        await seedCompanionWorkspace({
          workspaceRoot: projectWorkspaceRoot,
          title: project.title,
          repositoryUrl: project.repositoryUrl,
          favicon: project.favicon,
        });
      }),
  );
  // The environment server begins listening before it finishes migrating the
  // database, so wait for the schema before deleting from and reseeding it.
  await waitForSeedableSchema(dbPath);
  seedDatabase(dbPath, workspaceRoots, projects, threads, now);

  const terminalDirectory = NodePath.join(input.baseDir, "userdata", "logs", "terminals");
  if (selectedProjectIds.has(SHOWCASE_PROJECT_ID)) {
    const safeThreadId = Buffer.from(SHOWCASE_THREAD_ID).toString("base64url");
    await NodeFSP.mkdir(terminalDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(terminalDirectory, `terminal_${safeThreadId}.log`),
      SHOWCASE_TERMINAL_BUFFER,
    );
  }
  return { dbPath, workspaceRoot };
}
