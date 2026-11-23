import { setLoadMarkSink, type LoadMarkDetail } from "@t3tools/client-runtime/load-marks";
import { Directory, File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import { createLoadMarkJournal } from "./load-mark-journal";
import { javascriptStartedAt } from "./startup-clock";

/**
 * Writes client-runtime load marks to Documents/diagnostics/load-marks.jsonl,
 * so how long loading takes on the phone can be read off it with
 * `xcrun devicectl device copy from --domain-type appDataContainer`.
 * Each line holds the mark, milliseconds since the JS runtime started, and
 * wall-clock time to line it up with the server's traces.
 */
function logFile(): File {
  const directory = new Directory(Paths.document, "diagnostics");
  if (!directory.exists) directory.create({ intermediates: true });
  return new File(directory, "load-marks.jsonl");
}

const journal = createLoadMarkJournal({
  read: async () => {
    const file = logFile();
    return file.exists ? file.text() : "";
  },
  write: (text) => logFile().write(text),
});

export const readLoadMarks = () => journal.read();

function record(name: string, atMs: number, detail?: LoadMarkDetail): void {
  journal.record(
    JSON.stringify({
      name,
      atMs: Math.round(atMs),
      // The entry timestamp was captured before application modules evaluated.
      wallMs: Math.round(Date.now() - (performance.now() - atMs)),
      ...detail,
    }),
  );
}

export function installLoadMarks(): void {
  setLoadMarkSink(record);
  record("app.entry", javascriptStartedAt);
  record("app.launch", performance.now());
  AppState.addEventListener("change", (state) => {
    record(`app.${state}`, performance.now());
  });
}
