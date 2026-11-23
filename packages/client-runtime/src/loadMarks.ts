/**
 * Timing marks for how long loading takes on a real device: when the socket
 * opens, when each snapshot arrives and is applied, when a chat goes live.
 * They cost nothing until a client installs a sink; the iPhone app writes
 * them to a file a developer can copy off the phone.
 *
 * @module loadMarks
 */
export type LoadMarkDetail = Readonly<Record<string, string | number | boolean>>;

export type LoadMarkSink = (name: string, atMs: number, detail?: LoadMarkDetail) => void;

let sink: LoadMarkSink | null = null;

export function setLoadMarkSink(next: LoadMarkSink | null): void {
  sink = next;
}

export function loadMarksEnabled(): boolean {
  return sink !== null;
}

export function markLoad(name: string, detail?: LoadMarkDetail): void {
  if (sink === null) return;
  try {
    sink(name, performance.now(), detail);
  } catch {
    // Measuring must never break loading.
  }
}
